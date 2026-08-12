import {
  ArrowUp,
  Bot,
  Check,
  Copy,
  FileCode2,
  GitCommitHorizontal,
  GitPullRequest,
  Network,
  RotateCw,
  Trash2,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams, useParams } from "react-router-dom";
import { ApiError, api } from "../../api/client";
import type { ChatExchange, Citation, QuestionResponse, Repository } from "../../api/contracts";
import { useAuth } from "../../auth/useAuth";
import { Avatar } from "../../components/Avatar";
import { MarkdownAnswer } from "../../components/MarkdownAnswer";
import { StatusBadge } from "../../components/StatusBadge";
import { Button, EmptyState, InlineAlert, Panel, Skeleton, Textarea } from "../../components/ui";
import { effectiveName, shortSha, titleCase } from "../../utils/format";
import { EvidenceInspector } from "./EvidenceInspector";

type TranscriptItem = ChatExchange;

const MIN_QUESTION_LENGTH = 3;

const examples = [
  "Where is repository authorization enforced before indexing?",
  "What calls IndexingWorker.process_job?",
  "Why was stale-event rejection added?",
];

export function QuestionWorkspacePage(): React.JSX.Element {
  const { repositoryId } = useParams();
  const [searchParams] = useSearchParams();
  const { accessToken, user } = useAuth();
  const [repository, setRepository] = useState<Repository | null>(null);
  const [question, setQuestion] = useState(searchParams.get("question") ?? "");
  const [items, setItems] = useState<TranscriptItem[]>([]);
  const [historyLoading, setHistoryLoading] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedCitation, setSelectedCitation] = useState<Citation | null>(null);
  const [clearing, setClearing] = useState(false);
  const [confirmingClear, setConfirmingClear] = useState(false);
  const [lastFailedQuestion, setLastFailedQuestion] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const transcriptEndRef = useRef<HTMLDivElement | null>(null);
  const canSubmit =
    question.trim().length >= MIN_QUESTION_LENGTH && !loading && Boolean(repository?.searchable);
  const userName = effectiveName(user);

  useEffect(() => {
    if (!accessToken || !repositoryId) return;
    const controller = new AbortController();
    void api
      .getRepository(accessToken, repositoryId, controller.signal)
      .then(setRepository)
      .catch(() => {
        if (!controller.signal.aborted) {
          setError("This repository is unavailable or access was revoked.");
        }
      });
    return () => controller.abort();
  }, [accessToken, repositoryId]);

  useEffect(() => {
    if (!accessToken || !repositoryId) return;
    const controller = new AbortController();
    void api
      .listMessages(accessToken, repositoryId, controller.signal)
      .then(setItems)
      .catch(() => {
        if (!controller.signal.aborted) {
          setError("Prior chat history could not be loaded.");
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setHistoryLoading(false);
      });
    return () => controller.abort();
  }, [accessToken, repositoryId]);

  useEffect(() => () => abortRef.current?.abort(), []);

  useEffect(() => {
    if (items.length === 0 && !loading) return;
    const anchor = transcriptEndRef.current;
    // Guarded because non-browser environments (and older engines) may not implement it.
    if (typeof anchor?.scrollIntoView === "function") {
      anchor.scrollIntoView({ behavior: "smooth", block: "end" });
    }
  }, [items.length, loading]);

  const submitLabel = useMemo(
    () => (loading ? "Generating grounded answer" : "Ask repository"),
    [loading],
  );

  async function submit(override?: string): Promise<void> {
    if (!accessToken || !repositoryId) return;
    const submitted = (override ?? question).trim();
    if (submitted.length < MIN_QUESTION_LENGTH || loading || !repository?.searchable) return;
    const controller = new AbortController();
    abortRef.current = controller;
    setLoading(true);
    setError(null);
    try {
      const response = await api.askQuestion(
        accessToken,
        repositoryId,
        submitted,
        controller.signal,
      );
      setItems((current) => [...current, { question: submitted, response }]);
      setQuestion("");
      setLastFailedQuestion(null);
    } catch (caught) {
      if (!(caught instanceof DOMException && caught.name === "AbortError")) {
        setLastFailedQuestion(submitted);
        setError(
          caught instanceof ApiError
            ? explainQuestionError(caught)
            : "The answer service is temporarily unavailable.",
        );
      }
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
      setLoading(false);
    }
  }

  function onComposerKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>): void {
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault();
      void submit();
    }
  }

  async function clearHistory(): Promise<void> {
    if (!accessToken || !repositoryId || clearing) return;
    setClearing(true);
    setError(null);
    try {
      await api.clearMessages(accessToken, repositoryId);
      setItems([]);
      setSelectedCitation(null);
      setConfirmingClear(false);
    } catch (caught) {
      setError(
        caught instanceof ApiError ? caught.message : "The chat history could not be cleared.",
      );
    } finally {
      setClearing(false);
    }
  }

  function retryLast(): void {
    if (loading || !lastFailedQuestion) return;
    setQuestion(lastFailedQuestion);
    void submit(lastFailedQuestion);
  }

  return (
    <section className="workspace page">
      <header className="workspace__context">
        <div>
          <p className="eyebrow">Repository question</p>
          <h1>{repository?.github_full_name ?? "Loading repository"}</h1>
        </div>
        {repository ? (
          <div className="workspace__context-meta">
            <StatusBadge status={repository.indexing_status} />
            <span className="mono">{shortSha(repository.active_commit_sha)}</span>
            {items.length > 0 ? (
              <Button
                aria-label="Clear chat history"
                onClick={() => setConfirmingClear(true)}
                variant="quiet"
              >
                <Trash2 aria-hidden="true" size={15} />
                Clear chat
              </Button>
            ) : null}
          </div>
        ) : null}
      </header>
      {error ? (
        <InlineAlert tone="error">
          <span>{error}</span>
          {lastFailedQuestion && !loading ? (
            <Button className="inline-alert__action" onClick={retryLast} variant="quiet">
              <RotateCw aria-hidden="true" size={14} />
              Retry
            </Button>
          ) : null}
        </InlineAlert>
      ) : null}
      {repository && !repository.searchable ? (
        <InlineAlert tone="warning">
          This repository does not have an active searchable index. You can review its indexing
          status and try again after a successful activation.
        </InlineAlert>
      ) : null}
      <div
        className={selectedCitation ? "workspace-grid workspace-grid--inspector" : "workspace-grid"}
      >
        <div className="workspace-content">
          <main className="transcript" aria-label="Question workspace">
            {historyLoading ? (
              <div className="transcript-loading">
                <Skeleton className="skeleton--row" />
                <Skeleton className="skeleton--card" />
              </div>
            ) : items.length === 0 ? (
              <WorkspaceEmpty onChoose={setQuestion} />
            ) : (
              items.map((item, index) => (
                <TranscriptEntry
                  key={`${index}-${item.question}`}
                  item={item}
                  onCitation={setSelectedCitation}
                  userName={userName}
                  userColor={user?.avatar_color}
                />
              ))
            )}
            {loading ? <GeneratingState onCancel={() => abortRef.current?.abort()} /> : null}
            <div aria-hidden="true" ref={transcriptEndRef} />
          </main>
          <section className="composer" aria-label="Ask a repository question">
            <label htmlFor="question-input">
              <span className="sr-only">
                Question about {repository?.github_full_name ?? "repository"}
              </span>
            </label>
            <Textarea
              id="question-input"
              maxLength={4096}
              onChange={(event) => setQuestion(event.target.value)}
              onKeyDown={onComposerKeyDown}
              placeholder="Ask about the active repository index…"
              value={question}
            />
            <div className="composer__footer">
              <span>Ctrl/Cmd + Enter to submit · 4,096 character limit</span>
              <div className="button-row">
                {loading ? (
                  <Button onClick={() => abortRef.current?.abort()} variant="quiet">
                    Cancel
                  </Button>
                ) : null}
                <Button
                  aria-label={submitLabel}
                  disabled={!canSubmit}
                  loading={loading}
                  onClick={() => void submit()}
                  variant="primary"
                >
                  <ArrowUp aria-hidden="true" size={16} />
                  Ask
                </Button>
              </div>
            </div>
          </section>
        </div>
        <EvidenceInspector citation={selectedCitation} onClose={() => setSelectedCitation(null)} />
      </div>
      {confirmingClear ? (
        <ClearHistoryDialog
          loading={clearing}
          onCancel={() => setConfirmingClear(false)}
          onConfirm={() => void clearHistory()}
        />
      ) : null}
    </section>
  );
}

function ClearHistoryDialog({
  loading,
  onCancel,
  onConfirm,
}: {
  loading: boolean;
  onCancel(): void;
  onConfirm(): void;
}): React.JSX.Element {
  const confirmRef = useRef<HTMLButtonElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);

  useEffect(() => {
    previousFocus.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    confirmRef.current?.focus();
    return () => previousFocus.current?.focus();
  }, []);

  function onKeyDown(event: React.KeyboardEvent<HTMLElement>): void {
    if (event.key === "Escape" && !loading) {
      event.preventDefault();
      onCancel();
      return;
    }
    if (event.key !== "Tab") return;
    event.preventDefault();
    if (document.activeElement === confirmRef.current) cancelRef.current?.focus();
    else confirmRef.current?.focus();
  }

  return (
    <div className="dialog-backdrop" role="presentation">
      <section
        aria-describedby="clear-chat-description"
        aria-labelledby="clear-chat-title"
        aria-modal="true"
        className="dialog"
        onKeyDown={onKeyDown}
        role="dialog"
      >
        <h2 id="clear-chat-title">Clear this chat history?</h2>
        <p id="clear-chat-description">
          Your saved questions and answers for this repository are permanently deleted. The
          repository and its index are not affected.
        </p>
        <div className="button-row">
          <Button ref={confirmRef} variant="danger" loading={loading} onClick={onConfirm}>
            Delete chat history
          </Button>
          <Button ref={cancelRef} disabled={loading} onClick={onCancel}>
            Cancel
          </Button>
        </div>
      </section>
    </div>
  );
}

function WorkspaceEmpty({ onChoose }: { onChoose(value: string): void }): React.JSX.Element {
  return (
    <EmptyState title="Ask about the active index">
      <span>
        Answers cite current code, GitHub history, or static callers. Repository content remains
        inert data.
      </span>
      <div className="suggestion-list">
        {examples.map((example) => (
          <button key={example} onClick={() => onChoose(example)}>
            {example}
            <ArrowUp aria-hidden="true" size={15} />
          </button>
        ))}
      </div>
    </EmptyState>
  );
}

function GeneratingState({ onCancel }: { onCancel(): void }): React.JSX.Element {
  return (
    <Panel className="generating-state">
      <Bot aria-hidden="true" size={18} />
      <div>
        <strong>Preparing a grounded answer</strong>
        <p>Codenaut is using only the active repository evidence and approved tools.</p>
      </div>
      <Button onClick={onCancel} variant="quiet">
        Cancel
      </Button>
    </Panel>
  );
}

function TranscriptEntry({
  item,
  onCitation,
  userName,
  userColor,
}: {
  item: TranscriptItem;
  onCitation(citation: Citation): void;
  userName: string;
  userColor: string | null | undefined;
}): React.JSX.Element {
  const responseTone =
    item.response.answerability === "answered"
      ? "success"
      : item.response.answerability === "partially_answered"
        ? "warning"
        : "neutral";
  return (
    <>
      <div className="chat-message chat-message--user">
        <span className="chat-message__avatar">
          <Avatar color={userColor} name={userName} size="sm" />
        </span>
        <div className="chat-message__body">
          <div className="chat-bubble">{item.question}</div>
        </div>
      </div>
      <div className="chat-message chat-message--assistant">
        <span className="chat-message__avatar chat-bot-mark" aria-hidden="true">
          <Bot size={16} />
        </span>
        <div className="chat-message__body">
          <div className="chat-bubble">
            {item.response.answerability !== "answered" ? (
              <InlineAlert tone={responseTone === "warning" ? "warning" : "neutral"}>
                {titleCase(item.response.answerability)}: this response is intentionally limited by
                available evidence.
              </InlineAlert>
            ) : null}
            <MarkdownAnswer>{item.response.answer}</MarkdownAnswer>
            <SourceChips citations={item.response.citations} onCitation={onCitation} />
            <ToolTrace trace={item.response.trace} />
          </div>
          <div className="chat-message__meta">
            <StatusBadge status={item.response.answerability} />
            <span>
              {item.response.duration_ms} ms · {item.response.tool_call_count} tools
            </span>
            <CopyAnswerButton answer={item.response.answer} />
          </div>
        </div>
      </div>
    </>
  );
}

function CopyAnswerButton({ answer }: { answer: string }): React.JSX.Element {
  const [copied, setCopied] = useState(false);

  async function copy(): Promise<void> {
    try {
      await navigator.clipboard?.writeText(answer);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      // Clipboard access can be denied; leaving the label unchanged is the correct signal.
    }
  }

  return (
    <button className="copy-answer" onClick={() => void copy()} type="button">
      {copied ? <Check aria-hidden="true" size={13} /> : <Copy aria-hidden="true" size={13} />}
      {copied ? "Copied" : "Copy"}
    </button>
  );
}

function citationLabel(citation: Citation): string {
  if (citation.source_type === "code") {
    const fileName = citation.file_path.split("/").pop() ?? citation.file_path;
    return `${fileName}:${citation.start_line}`;
  }
  if (citation.source_type === "caller") {
    return citation.caller_qualified_name;
  }
  if (citation.source_type === "commit") {
    return shortSha(citation.commit_sha);
  }
  return `PR #${citation.number}`;
}

function citationIcon(citation: Citation): React.ReactNode {
  switch (citation.source_type) {
    case "code":
      return <FileCode2 aria-hidden="true" size={13} />;
    case "caller":
      return <Network aria-hidden="true" size={13} />;
    case "commit":
      return <GitCommitHorizontal aria-hidden="true" size={13} />;
    case "pull_request":
      return <GitPullRequest aria-hidden="true" size={13} />;
  }
}

function SourceChips({
  citations,
  onCitation,
}: {
  citations: Citation[];
  onCitation(citation: Citation): void;
}): React.JSX.Element {
  if (citations.length === 0)
    return <p className="muted evidence-empty">No supporting citation was returned.</p>;
  return (
    <div className="source-chips" aria-label="Sources for this answer">
      <span className="source-chips__label">Sources</span>
      {citations.map((citation, index) => (
        <button
          className="source-chip"
          key={citation.evidence_id}
          onClick={() => onCitation(citation)}
        >
          <span className="source-chip__index">{index + 1}</span>
          {citationIcon(citation)}
          <span>{citationLabel(citation)}</span>
        </button>
      ))}
    </div>
  );
}

function ToolTrace({ trace }: { trace: QuestionResponse["trace"] }): React.JSX.Element | null {
  if (trace.length === 0) return null;
  return (
    <details className="tool-trace">
      <summary>Safe tool trace ({trace.length})</summary>
      <ol>
        {trace.map((step) => (
          <li key={step.step}>
            <span>{step.tool}</span>
            <span>{step.status}</span>
            <span>{step.duration_ms} ms</span>
            <span>{step.result_count} evidence</span>
            {step.failure_code ? <span>{step.failure_code}</span> : null}
          </li>
        ))}
      </ol>
    </details>
  );
}

function explainQuestionError(error: ApiError): string {
  if (error.status === 401) return "Your session expired. Sign in again to continue.";
  if (error.status === 404) return "This repository is unavailable or your access was revoked.";
  if (error.status === 422)
    return "Questions must be between 3 characters and the supported request limit.";
  if (error.status === 503)
    return "The repository answer service is temporarily unavailable. Your question is still in the composer.";
  return "The question could not be completed. Try again if the problem persists.";
}
