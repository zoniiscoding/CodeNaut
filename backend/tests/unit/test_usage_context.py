"""Task-local usage accumulation and its isolation guarantees."""

import asyncio

import pytest

from app.core.usage_context import (
    collect_usage,
    record_embedding_units,
    record_tokens,
    usage_context,
)


def test_tokens_and_embedding_units_accumulate_within_one_scope() -> None:
    with collect_usage() as usage:
        record_tokens(input_tokens=120, output_tokens=40)
        record_tokens(input_tokens=30, output_tokens=10)
        record_embedding_units(1)
        record_embedding_units(4)

    assert usage.input_tokens == 150
    assert usage.output_tokens == 50
    assert usage.embedding_units == 5
    assert usage.provider_calls == 2
    assert usage.observed_tokens is True


def test_absent_provider_usage_counts_the_call_without_claiming_token_counts() -> None:
    with collect_usage() as usage:
        record_tokens(input_tokens=None, output_tokens=None)

    assert usage.provider_calls == 1
    assert usage.input_tokens == 0
    assert usage.observed_tokens is False


def test_negative_provider_values_cannot_reduce_totals() -> None:
    with collect_usage() as usage:
        record_tokens(input_tokens=-5, output_tokens=-9)
        record_embedding_units(-3)

    assert usage.input_tokens == 0
    assert usage.output_tokens == 0
    assert usage.embedding_units == 0


def test_reporting_outside_a_scope_is_a_safe_no_op() -> None:
    record_tokens(input_tokens=10, output_tokens=10)
    record_embedding_units(10)

    assert usage_context.get() is None


def test_scope_is_restored_after_exit_and_on_error() -> None:
    def fail_inside_scope() -> None:
        with collect_usage():
            raise RuntimeError("boom")

    with collect_usage():
        assert usage_context.get() is not None
    assert usage_context.get() is None

    with pytest.raises(RuntimeError):
        fail_inside_scope()
    assert usage_context.get() is None


def test_concurrent_operations_do_not_share_totals() -> None:
    async def operation(tokens: int) -> int:
        with collect_usage() as usage:
            record_tokens(input_tokens=tokens, output_tokens=0)
            await asyncio.sleep(0)
            record_tokens(input_tokens=tokens, output_tokens=0)
            return usage.input_tokens

    async def run() -> list[int]:
        return list(await asyncio.gather(operation(100), operation(7), operation(1000)))

    assert asyncio.run(run()) == [200, 14, 2000]
