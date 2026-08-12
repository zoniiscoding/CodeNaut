"""Persisted chat transcript API contracts."""

from pydantic import BaseModel, ConfigDict, TypeAdapter

from app.schemas.questions import (
    AgentTraceStepResponse,
    RepositoryCitationResponse,
    RepositoryQuestionResponse,
)

citations_adapter: TypeAdapter[list[RepositoryCitationResponse]] = TypeAdapter(
    list[RepositoryCitationResponse]
)
trace_adapter: TypeAdapter[list[AgentTraceStepResponse]] = TypeAdapter(list[AgentTraceStepResponse])


class RepositoryChatExchangeResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    question: str
    response: RepositoryQuestionResponse
