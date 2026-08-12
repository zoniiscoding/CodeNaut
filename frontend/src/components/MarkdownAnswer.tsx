import ReactMarkdown from "react-markdown";
import rehypeSanitize from "rehype-sanitize";
import { tokenizePython } from "../utils/highlight";

/** Highlight only fenced Python blocks; inline code stays visually quiet. */
function HighlightedCode({
  className,
  children,
  ...props
}: React.ComponentPropsWithoutRef<"code">): React.JSX.Element {
  const isPythonBlock = typeof className === "string" && /language-(python|py)\b/.test(className);
  if (!isPythonBlock || typeof children !== "string") {
    return (
      <code className={className} {...props}>
        {children}
      </code>
    );
  }
  return (
    <code className={className} {...props}>
      {tokenizePython(children).map((token, index) => (
        <span className={`tok tok--${token.kind}`} key={index}>
          {token.value}
        </span>
      ))}
    </code>
  );
}

export function MarkdownAnswer({ children }: { children: string }): React.JSX.Element {
  return (
    <div className="markdown-answer">
      <ReactMarkdown
        rehypePlugins={[rehypeSanitize]}
        components={{
          a: ({ children: linkChildren }) => (
            <span className="markdown-answer__link-text">{linkChildren}</span>
          ),
          code: HighlightedCode,
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
