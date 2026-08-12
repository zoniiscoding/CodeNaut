"""Authenticated grounded repository question endpoint."""

import time
import uuid
from typing import cast

import structlog
from fastapi import APIRouter, Request, Response, status

from app.agent.models import CallerEvidence, CommitEvidence, PullRequestEvidence
from app.agent.provider import resolve_agent_provider
from app.agent.service import AgentQuestionService
from app.agent.tools import AgentToolRegistry, FindCallersTool, GetHistoryTool, SearchCodeTool
from app.auth.dependencies import CurrentUser
from app.core.config import Settings
from app.core.errors import APIError
from app.core.usage_context import UsageAccumulator, collect_usage
from app.db.models.chat import ChatMessage
from app.db.models.enums import AnswerStatus, AnswerUncertaintyLevel, ChatRole
from app.db.session import Database
from app.embeddings.client import EmbeddingProviderProtocol
from app.github.client import GitHubClientProtocol, GitHubHistoryClientProtocol
from app.llm.client import LLMProviderProtocol
from app.rag.models import Answerability, AnswerUncertainty, Evidence
from app.rag.query import QuestionValidationError
from app.schemas.chat import RepositoryChatExchangeResponse, citations_adapter, trace_adapter
from app.schemas.errors import ErrorCode
from app.schemas.questions import (
    AgentTraceStepResponse,
    RepositoryCallerCitationResponse,
    RepositoryCitationResponse,
    RepositoryCodeCitationResponse,
    RepositoryCommitCitationResponse,
    RepositoryPullRequestCitationResponse,
    RepositoryQuestionRequest,
    RepositoryQuestionResponse,
)
from app.services.chat import ChatHistoryService
from app.services.installations import InstallationAccessError, InstallationService
from app.services.rate_limit import RateLimiterProtocol
from app.services.usage import OPERATION_REPOSITORY_QUESTION, UsageService
from app.vector.qdrant import VectorStoreProtocol

router = APIRouter()
logger = structlog.get_logger(__name__)

_STATUS_TO_ANSWERABILITY = {
    AnswerStatus.ANSWERED: Answerability.ANSWERED,
    AnswerStatus.PARTIALLY_ANSWERED: Answerability.PARTIALLY_ANSWERED,
    AnswerStatus.INSUFFICIENT_EVIDENCE: Answerability.INSUFFICIENT_EVIDENCE,
    AnswerStatus.UNSUPPORTED_QUESTION: Answerability.UNSUPPORTED_QUESTION,
    AnswerStatus.STALE_INDEX: Answerability.TEMPORARILY_UNAVAILABLE,
    AnswerStatus.TOOL_FAILURE: Answerability.TEMPORARILY_UNAVAILABLE,
}
_LEVEL_TO_UNCERTAINTY = {
    AnswerUncertaintyLevel.LOW: AnswerUncertainty.LOW,
    AnswerUncertaintyLevel.MEDIUM: AnswerUncertainty.MEDIUM,
    AnswerUncertaintyLevel.HIGH: AnswerUncertainty.HIGH,
    AnswerUncertaintyLevel.NOT_APPLICABLE: AnswerUncertainty.NOT_APPLICABLE,
}


def _service(request: Request) -> AgentQuestionService:
    database = cast(Database, request.app.state.database)
    settings = cast(Settings, request.app.state.settings)
    installations = InstallationService(
        database=database,
        github=cast(GitHubClientProtocol, request.app.state.github_client),
        settings=settings,
    )
    embeddings = cast(EmbeddingProviderProtocol, request.app.state.embedding_provider)
    vectors = cast(VectorStoreProtocol, request.app.state.vector_store)
    history_github = cast(GitHubHistoryClientProtocol, request.app.state.github_client)
    return AgentQuestionService(
        database=database,
        installations=installations,
        provider=resolve_agent_provider(cast(LLMProviderProtocol, request.app.state.llm_provider)),
        registry=AgentToolRegistry(
            (
                SearchCodeTool(embeddings=embeddings, vectors=vectors, settings=settings),
                GetHistoryTool(
                    installations=installations,
                    github=history_github,
                    settings=settings,
                ),
                FindCallersTool(
                    database=database,
                    installations=installations,
                    settings=settings,
                ),
            )
        ),
        settings=settings,
    )


async def _record_usage(
    request: Request,
    *,
    user_id: uuid.UUID,
    repository_id: uuid.UUID,
    usage: UsageAccumulator,
    latency_ms: int,
    success: bool,
) -> None:
    """Persist metered usage without ever failing the caller's request."""
    try:
        service = UsageService(database=cast(Database, request.app.state.database))
        await service.record_operation(
            user_id=user_id,
            repository_id=repository_id,
            operation=OPERATION_REPOSITORY_QUESTION,
            usage=usage,
            latency_ms=latency_ms,
            success=success,
        )
    except Exception:  # noqa: BLE001 - accounting must never break the answer path
        logger.warning("usage_record_failed", repository_id=str(repository_id))


def _chat_service(request: Request) -> ChatHistoryService:
    database = cast(Database, request.app.state.database)
    settings = cast(Settings, request.app.state.settings)
    return ChatHistoryService(
        database=database,
        installations=InstallationService(
            database=database,
            github=cast(GitHubClientProtocol, request.app.state.github_client),
            settings=settings,
        ),
    )


@router.post("/{repository_id}/questions")
async def ask_repository_question(
    repository_id: uuid.UUID,
    payload: RepositoryQuestionRequest,
    request: Request,
    user: CurrentUser,
) -> RepositoryQuestionResponse:
    limiter = cast(RateLimiterProtocol, request.app.state.rate_limiter)
    decision = await limiter.check_question(user.id)
    if not decision.allowed:
        raise APIError(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            code=ErrorCode.RATE_LIMIT_EXCEEDED,
            message="Question rate limit reached. Try again shortly.",
            details={"retry_after_seconds": decision.retry_after_seconds},
        )
    service = _service(request)
    started = time.perf_counter()
    answered = False
    with collect_usage() as usage:
        try:
            question = service.prepare_question(payload.question)
            result = await service.answer(
                user_id=user.id,
                repository_id=repository_id,
                question=question,
            )
            answered = True
        except QuestionValidationError as error:
            raise APIError(
                status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
                code=ErrorCode.VALIDATION_ERROR,
                message="Question is invalid",
            ) from error
        except InstallationAccessError as error:
            raise APIError(
                status_code=status.HTTP_404_NOT_FOUND,
                code=ErrorCode.NOT_FOUND,
                message="Repository was not found",
            ) from error
        finally:
            await _record_usage(
                request,
                user_id=user.id,
                repository_id=repository_id,
                usage=usage,
                latency_ms=round((time.perf_counter() - started) * 1000),
                success=answered,
            )
    by_id = {item.evidence_id: item for item in result.evidence}
    citations: list[RepositoryCitationResponse] = []
    for evidence_id in result.cited_evidence_ids:
        item = by_id[evidence_id]
        if isinstance(item, Evidence):
            citations.append(
                RepositoryCodeCitationResponse(
                    evidence_id=item.evidence_id,
                    file_path=item.file_path,
                    start_line=item.start_line,
                    end_line=item.end_line,
                    symbol_name=item.symbol_name,
                    qualified_symbol_name=item.qualified_symbol_name,
                    chunk_type=item.chunk_type,
                    commit_sha=result.commit_sha or "",
                    supporting_excerpt=item.content,
                )
            )
        elif isinstance(item, CommitEvidence):
            citations.append(
                RepositoryCommitCitationResponse(
                    evidence_id=item.evidence_id,
                    commit_sha=item.commit_sha,
                    message=item.message,
                    committed_at=item.committed_at.isoformat(),
                    author_login=item.author_login,
                    parent_shas=list(item.parent_shas),
                    changed_paths=list(item.changed_paths),
                    patch_excerpt=item.patch_excerpt,
                    html_url=item.html_url,
                )
            )
        elif isinstance(item, CallerEvidence):
            citations.append(
                RepositoryCallerCitationResponse(
                    evidence_id=item.evidence_id,
                    target_symbol_name=item.target_symbol_name,
                    target_qualified_name=item.target_qualified_name,
                    target_file_path=item.target_file_path,
                    caller_symbol_name=item.caller_symbol_name,
                    caller_qualified_name=item.caller_qualified_name,
                    caller_file_path=item.caller_file_path,
                    caller_start_line=item.caller_start_line,
                    caller_end_line=item.caller_end_line,
                    call_line=item.call_line,
                    call_end_line=item.call_end_line,
                    call_expression=item.call_expression,
                    resolution_type=item.resolution_type,
                    confidence=item.confidence,
                    commit_sha=item.commit_sha,
                    index_version=item.index_version,
                    limitation=item.limitation,
                )
            )
        elif isinstance(item, PullRequestEvidence):
            citations.append(
                RepositoryPullRequestCitationResponse(
                    evidence_id=item.evidence_id,
                    number=item.number,
                    title=item.title,
                    state=item.state,
                    author_login=item.author_login,
                    merged_at=item.merged_at.isoformat() if item.merged_at else None,
                    merge_commit_sha=item.merge_commit_sha,
                    changed_paths=list(item.changed_paths),
                    body_excerpt=item.body_excerpt,
                    html_url=item.html_url,
                )
            )
    trace = [
        AgentTraceStepResponse(
            step=item.step,
            tool=item.tool.value,
            argument_fingerprint=item.argument_fingerprint,
            status=item.status.value,
            duration_ms=item.duration_ms,
            result_count=item.result_count,
            failure_code=item.failure_code,
            contributed_evidence=item.contributed_evidence,
        )
        for item in result.trace
    ]
    response = RepositoryQuestionResponse(
        repository_id=result.repository_id,
        answer=result.answer,
        answerability=result.answerability,
        uncertainty=result.uncertainty,
        citations=citations,
        indexed_commit_sha=result.commit_sha,
        active_index_version=result.index_version,
        retrieved_evidence_count=result.retrieved_evidence_count,
        tool_call_count=len(result.trace),
        duration_ms=result.duration_ms,
        trace=trace,
    )
    try:
        await _chat_service(request).record_exchange(
            user_id=user.id,
            repository_id=repository_id,
            question=question.text,
            answer=result.answer,
            answerability=result.answerability,
            uncertainty=result.uncertainty,
            indexed_commit_sha=result.commit_sha,
            active_index_version=result.index_version,
            retrieved_evidence_count=result.retrieved_evidence_count,
            citations_json=[item.model_dump(mode="json") for item in citations],
            trace_json=[item.model_dump(mode="json") for item in trace],
        )
    except Exception:  # noqa: BLE001 - persisting history must never fail the answer response
        logger.warning("chat_history_persist_failed", repository_id=str(repository_id))
    return response


@router.get("/{repository_id}/messages")
async def list_repository_messages(
    repository_id: uuid.UUID,
    request: Request,
    user: CurrentUser,
) -> list[RepositoryChatExchangeResponse]:
    try:
        messages = await _chat_service(request).list_messages(
            user_id=user.id, repository_id=repository_id
        )
    except InstallationAccessError as error:
        raise APIError(
            status_code=status.HTTP_404_NOT_FOUND,
            code=ErrorCode.NOT_FOUND,
            message="Repository was not found",
        ) from error
    return _pair_messages(repository_id, messages)


@router.delete("/{repository_id}/messages", status_code=status.HTTP_204_NO_CONTENT)
async def clear_repository_messages(
    repository_id: uuid.UUID,
    request: Request,
    user: CurrentUser,
) -> Response:
    try:
        removed = await _chat_service(request).clear_history(
            user_id=user.id, repository_id=repository_id
        )
    except InstallationAccessError as error:
        raise APIError(
            status_code=status.HTTP_404_NOT_FOUND,
            code=ErrorCode.NOT_FOUND,
            message="Repository was not found",
        ) from error
    logger.info(
        "chat_history_cleared",
        repository_id=str(repository_id),
        removed_message_count=removed,
    )
    return Response(status_code=status.HTTP_204_NO_CONTENT)


def _pair_messages(
    repository_id: uuid.UUID, messages: list[ChatMessage]
) -> list[RepositoryChatExchangeResponse]:
    exchanges: list[RepositoryChatExchangeResponse] = []
    pending_question: str | None = None
    for item in messages:
        if item.role is ChatRole.USER:
            pending_question = item.content
            continue
        if item.role is not ChatRole.ASSISTANT or pending_question is None:
            continue
        exchanges.append(
            RepositoryChatExchangeResponse(
                question=pending_question,
                response=RepositoryQuestionResponse(
                    repository_id=repository_id,
                    answer=item.content,
                    answerability=(
                        _STATUS_TO_ANSWERABILITY[item.answer_status]
                        if item.answer_status
                        else Answerability.TEMPORARILY_UNAVAILABLE
                    ),
                    uncertainty=(
                        _LEVEL_TO_UNCERTAINTY[item.uncertainty]
                        if item.uncertainty
                        else AnswerUncertainty.NOT_APPLICABLE
                    ),
                    citations=citations_adapter.validate_python(item.evidence_json),
                    indexed_commit_sha=item.indexed_commit_sha,
                    active_index_version=item.active_index_version or 0,
                    retrieved_evidence_count=item.retrieved_evidence_count or 0,
                    tool_call_count=len(item.tool_trace_json),
                    duration_ms=0,
                    trace=trace_adapter.validate_python(item.tool_trace_json),
                ),
            )
        )
        pending_question = None
    return exchanges
