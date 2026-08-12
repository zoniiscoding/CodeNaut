import { Github, GitBranch, ShieldCheck, Sparkles, Telescope } from "lucide-react";
import { Navigate, useLocation } from "react-router-dom";
import { useAuth } from "../../auth/useAuth";
import { Button, InlineAlert, Panel } from "../../components/ui";

const heroPoints = [
  {
    icon: <Telescope aria-hidden="true" size={17} />,
    text: "Ask questions and get answers grounded in the code you actually have access to.",
  },
  {
    icon: <GitBranch aria-hidden="true" size={17} />,
    text: "Every answer cites real code, commits, pull requests, or static call sites — never a guess.",
  },
  {
    icon: <Sparkles aria-hidden="true" size={17} />,
    text: "Import any public repository by URL, or connect the GitHub App for private access.",
  },
];

export function SignInPage(): React.JSX.Element {
  const { state, signIn } = useAuth();
  const location = useLocation();
  const destination = (location.state as { from?: string } | null)?.from ?? "/repositories";
  if (state === "authenticated") {
    return <Navigate replace to={destination} />;
  }
  return (
    <main className="sign-in">
      <a className="skip-link" href="#sign-in-panel">
        Skip to sign in
      </a>
      <section className="sign-in__hero" aria-hidden="true">
        <div className="brand brand--large">
          <span className="brand__mark" aria-hidden="true">
            C
          </span>
          <span>Codenaut</span>
        </div>
        <div className="sign-in__hero-content">
          <h2>Navigate any codebase with grounded, cited answers.</h2>
          <p>
            Codenaut reads the repositories you&rsquo;re authorized to see and answers questions
            with evidence attached — not guesses.
          </p>
          <div className="sign-in__hero-points">
            {heroPoints.map((point) => (
              <div key={point.text}>
                {point.icon}
                <span>{point.text}</span>
              </div>
            ))}
          </div>
        </div>
      </section>
      <div className="sign-in__form-side">
        <Panel className="sign-in__panel">
          <div id="sign-in-panel" className="sign-in__copy">
            <p className="eyebrow">Sign in</p>
            <h1>Welcome to Codenaut</h1>
            <p>
              Sign in with Google or GitHub. Import public repositories by URL, or connect the
              GitHub App for private repositories.
            </p>
          </div>
          {state === "expired" ? (
            <InlineAlert tone="warning">
              Your session ended. Continue with Google or GitHub to start a new session.
            </InlineAlert>
          ) : null}
          <div className="sign-in__actions">
            <Button className="sign-in__action" variant="primary" onClick={() => signIn("google")}>
              <span aria-hidden="true" className="provider-mark">
                G
              </span>
              Continue with Google
            </Button>
            <Button className="sign-in__action" onClick={() => signIn("github")}>
              <Github aria-hidden="true" size={18} />
              Continue with GitHub
            </Button>
          </div>
          <div className="sign-in__trust">
            <ShieldCheck aria-hidden="true" size={17} />
            <span>
              Provider tokens stay server-side. Private access still requires repositories approved
              through your GitHub App installation.
            </span>
          </div>
        </Panel>
      </div>
    </main>
  );
}
