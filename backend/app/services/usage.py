"""Content-free operational usage accounting."""

import uuid

import structlog

from app.core.usage_context import UsageAccumulator
from app.db.models.usage_record import UsageRecord
from app.db.session import Database

logger = structlog.get_logger(__name__)

OPERATION_REPOSITORY_QUESTION = "repository_question"


class UsageService:
    """Persist metered operations without prompts, answers, or repository content."""

    def __init__(self, *, database: Database) -> None:
        self._database = database

    async def record_operation(
        self,
        *,
        user_id: uuid.UUID,
        repository_id: uuid.UUID,
        operation: str,
        usage: UsageAccumulator,
        latency_ms: int,
        success: bool,
    ) -> None:
        record = UsageRecord(
            user_id=user_id,
            repository_id=repository_id,
            operation=operation,
            tool_name=None,
            latency_ms=max(latency_ms, 0),
            # Leave token columns NULL rather than storing zeros when no provider
            # reported usage; a null means "unknown", not "free".
            input_tokens=usage.input_tokens if usage.observed_tokens else None,
            output_tokens=usage.output_tokens if usage.observed_tokens else None,
            embedding_units=usage.embedding_units or None,
            estimated_cost=None,
            success=success,
        )
        async with self._database.session() as session:
            session.add(record)
            await session.commit()
