import { useEffect, type ReactNode } from "react";
import { useUi } from "../store";
import { Card, CopyButton } from "./ui";
import { Icon } from "./icons";
import type { ProviderId, ProviderInfo } from "../../../src/core/model";
import skillText from "../../../skills/save-tokens-creator/SKILL.md?raw";

const LEADERBOARD = "https://artificialanalysis.ai/leaderboards/models";
const GO = "https://opencode.ai/go";

// The whole skill, plus install paths for the selected discovered provider.
function setupPrompt(providers: ProviderInfo[] | undefined, source: ProviderId | undefined): string {
  const claude = providers?.filter((provider) => provider.kind === "claude") ?? [];
  const selected = claude.find((provider) => provider.id === source);
  const claudeDirs = selected ? [selected.dir ?? "~/.claude"] : claude.map((provider) => provider.dir ?? "~/.claude");
  const targets = [...new Set(claudeDirs.length ? claudeDirs : ["~/.claude"])]
    .map((dir) => `${dir}/skills/save-tokens-creator/SKILL.md`);
  const codexDir = providers?.find((provider) => provider.kind === "codex")?.dir ?? "~/.codex";
  targets.push(`${codexDir}/skills/save-tokens-creator/SKILL.md`);
  return `Set up the save-tokens-creator agent skill on this machine.

Write the Markdown below to ${targets.join(" and to\n")} (create the directories if they are missing).
Keep the YAML front matter. Then read the file and follow it whenever you pick a model for a task.

If you prefer the packaged route, run: npx -y token-furnace setup --apply
That installs this skill for each discovered Claude Code install and Codex.

${skillText}`;
}

interface Tip {
  id: string;
  title: string;
  body: ReactNode;
  action: ReactNode;
}

export function Tips({ providers, source }: { providers?: ProviderInfo[]; source?: ProviderId }) {
  const done = useUi((state) => state.doneTips);
  const toggleTip = useUi((state) => state.toggleTip);
  const setModal = useUi((state) => state.setModal);
  const live = location.protocol === "http:" || location.protocol === "https:";

  // Applying the auto fixes completes the first tip without a second click.
  useEffect(() => {
    const onFixed = () => {
      if (!useUi.getState().doneTips.includes("auto-fix")) useUi.getState().toggleTip("auto-fix");
    };
    window.addEventListener("config-fixed", onFixed);
    return () => window.removeEventListener("config-fixed", onFixed);
  }, []);

  const tips: Tip[] = [
    {
      id: "auto-fix",
      title: "Run the auto fix",
      body: (
        <>
          Checkup lists the issues found in the recent sessions. <strong>Auto Fixes</strong> repairs the
          agent configuration in one pass. Every changed file is backed up before it is written.
        </>
      ),
      action: (
        <button
          type="button"
          disabled={!live}
          title={live ? undefined : "Open the live dashboard with token-furnace serve"}
          onClick={() => setModal("auto-fixes")}
          className="text-xs px-2.5 py-1 bg-accent text-bg font-semibold rounded-lg border border-accent hover:brightness-110 disabled:opacity-50"
        >
          Open Auto Fixes
        </button>
      ),
    },
    {
      id: "opencode-go",
      title: "Add an OpenCode Go plan on top of Codex/Claude Code",
      body: (
        <>
          For about $10/month, the OpenCode Go plan opens the free Zen models and adds a weekly quota to
          absorb routine workload. Route the easy work to a free Zen model and keep your paid plan for the
          hard turns. The save-tokens skill below picks the best free model for coding.
        </>
      ),
      action: (
        <a
          href={GO}
          target="_blank"
          rel="noreferrer"
          className="text-xs px-2.5 py-1 bg-chip rounded-lg border border-line hover:border-accent"
        >
          opencode.ai/go
        </a>
      ),
    },
    {
      id: "save-tokens-creator",
      title: "Create a save-tokens skill",
      body: (
        <>
          The <code className="mx-1 px-1 rounded bg-chip">save-tokens-creator</code> skill reads the
          subscriptions and models on this machine, pulls the live ranking from{" "}
          <a href={LEADERBOARD} target="_blank" rel="noreferrer" className="text-accent underline">
            artificialanalysis.ai
          </a>
          , and maps the best model to each use case. It never suggests a model you cannot reach. Copy the
          whole skill into any other agent to install it there. When you add a provider, plan or model, ask
          Claude or Codex to update the skill.
        </>
      ),
      action: (
        <CopyButton
          label="Copy skill"
          text={setupPrompt(providers, source)}
          className="text-xs px-2.5 py-1 bg-chip rounded-lg border border-line hover:border-accent"
        />
      ),
    },
  ];

  const open = tips.filter((tip) => !done.includes(tip.id));
  if (!open.length) {
    return (
      <Card title="Tips" icon="Lightbulb">
        <p className="text-sm text-muted">You are all set. No tips left.</p>
      </Card>
    );
  }
  return (
    <Card
      title="Tips"
      sub="A short setup path to cut the furnace bill"
      icon="Lightbulb"
      right={<span className="text-xs text-muted">{open.length} left</span>}
    >
      <ul className="divide-y divide-line">
        {open.map((tip) => (
          <li key={tip.id} className="flex gap-3 py-3">
            <span className="mt-0.5 shrink-0 size-6 rounded-full bg-accent/10 text-accent grid place-items-center text-xs font-semibold">
              {tips.findIndex((t) => t.id === tip.id) + 1}
            </span>
            <div className="min-w-0 flex-1 space-y-1.5">
              <div className="text-sm font-medium">{tip.title}</div>
              <p className="text-xs text-muted">{tip.body}</p>
              <div className="flex items-center gap-2 pt-0.5">
                {tip.action}
                <button
                  type="button"
                  onClick={() => toggleTip(tip.id)}
                  className="text-xs px-2.5 py-1 rounded-lg border border-line text-muted hover:text-ink inline-flex items-center gap-1"
                >
                  <Icon name="Check" size={13} /> Done
                </button>
              </div>
            </div>
          </li>
        ))}
      </ul>
    </Card>
  );
}
