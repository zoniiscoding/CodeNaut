"""Per-request accumulation of billable units without touching provider protocols.

Provider clients report token and embedding counts into a task-local accumulator so
the API boundary can persist one content-free `UsageRecord` per operation. Context
variables are copied per asyncio task, so concurrent requests never share totals.
"""

from collections.abc import Iterator
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass, field


@dataclass(slots=True)
class UsageAccumulator:
    """Counters for one logical operation. Never holds prompts or repository text."""

    input_tokens: int = 0
    output_tokens: int = 0
    embedding_units: int = 0
    provider_calls: int = 0
    _observed_tokens: bool = field(default=False)

    def add_tokens(self, *, input_tokens: int | None, output_tokens: int | None) -> None:
        self.provider_calls += 1
        if input_tokens is not None:
            self.input_tokens += max(input_tokens, 0)
            self._observed_tokens = True
        if output_tokens is not None:
            self.output_tokens += max(output_tokens, 0)
            self._observed_tokens = True

    def add_embedding_units(self, units: int) -> None:
        self.embedding_units += max(units, 0)

    @property
    def observed_tokens(self) -> bool:
        """True when at least one provider reported usable token counts."""
        return self._observed_tokens


usage_context: ContextVar[UsageAccumulator | None] = ContextVar("usage_accumulator", default=None)


@contextmanager
def collect_usage() -> Iterator[UsageAccumulator]:
    """Scope one accumulator to the current task."""
    accumulator = UsageAccumulator()
    token = usage_context.set(accumulator)
    try:
        yield accumulator
    finally:
        usage_context.reset(token)


def record_tokens(*, input_tokens: int | None, output_tokens: int | None) -> None:
    """Report provider-declared token counts if an accumulator is active."""
    accumulator = usage_context.get()
    if accumulator is not None:
        accumulator.add_tokens(input_tokens=input_tokens, output_tokens=output_tokens)


def record_embedding_units(units: int) -> None:
    """Report embedded document/query counts if an accumulator is active."""
    accumulator = usage_context.get()
    if accumulator is not None:
        accumulator.add_embedding_units(units)
