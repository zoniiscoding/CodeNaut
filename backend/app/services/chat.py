"""Persistence for the single continuous per-user, per-repository chat transcript."""

import uuid
from datetime import UTC, datetime

from sqlalchemy import func, select, update
from sqlalchemy.exc import IntegrityError

from app.db.models.chat import ChatMessage, ChatSession
from app.db.models.enums import AnswerStatus, AnswerUncertaintyLevel, ChatRole
from app.db.models.repository import Repository
from app.db.session import Database
from app.rag.models import Answerability, AnswerUncertainty
from app.services.installations import InstallationService

_ANSWERABILITY_TO_STATUS = {
    Answerability.ANSWERED: AnswerStatus.ANSWERED,
    Answerability.PARTIALLY_ANSWERED: AnswerStatus.PARTIALLY_ANSWERED,
    Answerability.INSUFFICIENT_EVIDENCE: AnswerStatus.INSUFFICIENT_EVIDENCE,
    Answerability.UNSUPPORTED_QUESTION: AnswerStatus.UNSUPPORTED_QUESTION,
    # AnswerStatus has no direct equivalent; a tool/provider outage is the closest fit.
    Answerability.TEMPORARILY_UNAVAILABLE: AnswerStatus.TOOL_FAILURE,
}
_UNCERTAINTY_TO_LEVEL = {
    AnswerUncertainty.LOW: AnswerUncertaintyLevel.LOW,
    AnswerUncertainty.MEDIUM: AnswerUncertaintyLevel.MEDIUM,
    AnswerUncertainty.HIGH: AnswerUncertaintyLevel.HIGH,
    AnswerUncertainty.NOT_APPLICABLE: AnswerUncertaintyLevel.NOT_APPLICABLE,
}


class ChatHistoryService:
    """Load and append to the one continuous chat session a user has per repository."""

    def __init__(self, *, database: Database, installations: InstallationService) -> None:
        self._database = database
        self._installations = installations

    async def list_messages(
        self, *, user_id: uuid.UUID, repository_id: uuid.UUID
    ) -> list[ChatMessage]:
        await self._installations.get_authorized_repository(
            user_id=user_id, repository_id=repository_id
        )
        async with self._database.session() as session:
            session_row = await session.scalar(
                select(ChatSession).where(
                    ChatSession.repository_id == repository_id,
                    ChatSession.created_by_user_id == user_id,
                )
            )
            if session_row is None:
                return []
            result = await session.scalars(
                select(ChatMessage)
                .where(ChatMessage.session_id == session_row.id)
                .order_by(ChatMessage.created_at)
            )
            return list(result.all())

    async def clear_history(self, *, user_id: uuid.UUID, repository_id: uuid.UUID) -> int:
        """Delete only the caller's own session for this repository.

        Authorization is re-checked, and the delete is scoped by both repository and
        creator so one user can never clear another user's transcript. Messages are
        removed by the session's `ON DELETE CASCADE`.
        """
        await self._installations.get_authorized_repository(
            user_id=user_id, repository_id=repository_id
        )
        async with self._database.session() as session:
            session_row = await session.scalar(
                select(ChatSession).where(
                    ChatSession.repository_id == repository_id,
                    ChatSession.created_by_user_id == user_id,
                )
            )
            if session_row is None:
                return 0
            removed = await session.scalar(
                select(func.count())
                .select_from(ChatMessage)
                .where(ChatMessage.session_id == session_row.id)
            )
            await session.delete(session_row)
            await session.commit()
        return int(removed or 0)

    async def record_exchange(
        self,
        *,
        user_id: uuid.UUID,
        repository_id: uuid.UUID,
        question: str,
        answer: str,
        answerability: Answerability,
        uncertainty: AnswerUncertainty,
        indexed_commit_sha: str | None,
        active_index_version: int,
        retrieved_evidence_count: int,
        citations_json: list[dict[str, object]],
        trace_json: list[dict[str, object]],
    ) -> None:
        session_id = await self._get_or_create_session_id(
            user_id=user_id, repository_id=repository_id
        )
        now = datetime.now(UTC)
        async with self._database.session() as db_session:
            db_session.add(ChatMessage(session_id=session_id, role=ChatRole.USER, content=question))
            db_session.add(
                ChatMessage(
                    session_id=session_id,
                    role=ChatRole.ASSISTANT,
                    content=answer,
                    answer_status=_ANSWERABILITY_TO_STATUS[answerability],
                    uncertainty=_UNCERTAINTY_TO_LEVEL[uncertainty],
                    tool_trace_json=trace_json,
                    evidence_json=citations_json,
                    indexed_commit_sha=indexed_commit_sha,
                    active_index_version=active_index_version,
                    retrieved_evidence_count=retrieved_evidence_count,
                )
            )
            await db_session.execute(
                update(ChatSession).where(ChatSession.id == session_id).values(updated_at=now)
            )
            await db_session.commit()

    async def _get_or_create_session_id(
        self, *, user_id: uuid.UUID, repository_id: uuid.UUID
    ) -> uuid.UUID:
        async with self._database.session() as session:
            existing = await session.scalar(
                select(ChatSession.id).where(
                    ChatSession.repository_id == repository_id,
                    ChatSession.created_by_user_id == user_id,
                )
            )
            if existing is not None:
                return existing
            repository = await session.get_one(Repository, repository_id)
            created = ChatSession(
                repository_id=repository_id,
                created_by_user_id=user_id,
                title=f"{repository.github_full_name} chat",
            )
            session.add(created)
            try:
                await session.flush()
            except IntegrityError:
                await session.rollback()
                raced = await session.scalar(
                    select(ChatSession.id).where(
                        ChatSession.repository_id == repository_id,
                        ChatSession.created_by_user_id == user_id,
                    )
                )
                if raced is None:
                    raise
                return raced
            await session.commit()
            return created.id
