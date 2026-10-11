import { useCallback, useEffect, useState } from "react";
import type { PublicSettings } from "../../../src/services/notifications";
import { Card } from "./ui";
import { Modal } from "./modal";
import { useUi } from "../store";

const live = location.protocol === "http:" || location.protocol === "https:";
const PROVIDERS: { value: PublicSettings["conditions"]["usage"]["provider"]; label: string }[] = [
  { value: "any", label: "Any provider" },
  { value: "claude", label: "Claude" },
  { value: "codex", label: "Codex" },
  { value: "opencode", label: "OpenCode Go" },
];

/** Where the alerts go and when they fire. Credentials are stored on the machine, never here. */
export function Notifications() {
  const [saved, setSaved] = useState<PublicSettings | null>(null);
  const [draft, setDraft] = useState<PublicSettings | null>(null);
  const [status, setStatus] = useState<{ tone: "ok" | "warn"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const modal = useUi((state) => state.modal);
  const setModal = useUi((state) => state.setModal);

  const load = useCallback(async () => {
    if (!live) return;
    setStatus(null);
    const response = await fetch("/api/notifications", { cache: "no-store" }).catch(() => null);
    if (!response?.ok) {
      setStatus({ tone: "warn", text: "The saved settings could not be read." });
      return;
    }
    try {
      const next = (await response.json()) as PublicSettings;
      setSaved(next);
      setDraft(next);
    } catch {
      setStatus({ tone: "warn", text: "The saved settings could not be read." });
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const post = async (path: string, body: unknown) => {
    const response = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = (await response.json().catch(() => ({}))) as PublicSettings & {
      ok?: boolean; error?: string; skipped?: boolean;
      results?: { channel: string; ok: boolean; error: string | null }[];
    };
    return { response, data };
  };

  const save = async () => {
    if (!draft) return;
    setBusy(true);
    try {
      const { response, data } = await post("/api/notifications", {
        enabled: draft.enabled,
        ntfy: { enabled: draft.ntfy.enabled, server: draft.ntfy.server, topic: draft.ntfy.topic, token: draft.ntfy.token },
        telegram: { enabled: draft.telegram.enabled, chatId: draft.telegram.chatId, botToken: draft.telegram.botToken },
        conditions: {
          newReset: draft.conditions.newReset,
          upcoming: draft.conditions.upcoming,
          leadMinutes: draft.conditions.leadMinutes,
          usage: { enabled: draft.conditions.usage.enabled, percent: draft.conditions.usage.percent, provider: draft.conditions.usage.provider },
        },
        removeNtfyToken: remove.ntfy,
        removeTelegramToken: remove.telegram,
      });
      if (!response.ok) {
        setStatus({ tone: "warn", text: data.error ?? "The settings were refused." });
        return;
      }
      setSaved(data);
      setDraft(data);
      setRemove({ ntfy: false, telegram: false });
      setStatus({ tone: "ok", text: "Saved. Alerts use these settings from the next server refresh." });
    } catch {
      setStatus({ tone: "warn", text: "The settings could not be saved." });
    } finally {
      setBusy(false);
    }
  };

  const test = async () => {
    setBusy(true);
    try {
      const { data } = await post("/api/notifications/test", {});
      const lines = (data.results ?? []).map((result) => `${result.channel}: ${result.ok ? "sent" : result.error ?? "failed"}`);
      setStatus({
        tone: data.ok ? "ok" : "warn",
        text: data.skipped ? "Test send skipped: this machine has sending turned off."
          : lines.length ? lines.join(" · ") : "No channel is enabled yet.",
      });
    } catch {
      setStatus({ tone: "warn", text: "The test message could not be sent." });
    } finally {
      setBusy(false);
    }
  };

  const [remove, setRemove] = useState({ ntfy: false, telegram: false });
  const set = (change: (current: PublicSettings) => PublicSettings) => setDraft((current) => current ? change(current) : current);

  if (!live) return <p className="text-sm text-muted py-6">Start the live dashboard with token-furnace serve to change notification settings.</p>;
  if (!draft) return (
    <div className="py-6 space-y-3">
      <p className="text-sm text-muted">{status?.text ?? "Loading settings…"}</p>
      {status ? (
        <button type="button" onClick={() => void load()}
          className="text-xs px-3 py-1.5 rounded-lg border border-line bg-chip text-ink hover:border-accent">
          Try again
        </button>
      ) : null}
    </div>
  );

  const input = "mt-1 w-full rounded-lg border border-line bg-chip px-2.5 py-1.5 text-sm text-ink";
  const field = "flex flex-col min-w-0";

  return (
    <div className="space-y-3">
      <Card title="Notifications" icon="TriangleAlert"
        sub="Credentials stay on this machine. Alerts run while the server is running.">
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={draft.enabled}
            onChange={(event) => set((current) => ({ ...current, enabled: event.target.checked }))} />
          Send notifications from this server
        </label>
        <p className="mt-1 text-[11px] text-muted">
          Off by default. The server checks the conditions on its own every minute, so alerts work with no tab open.
        </p>
      </Card>

      <div className="grid gap-3 lg:grid-cols-2">
        <Card title="ntfy" icon="Activity" sub="A topic on ntfy.sh or your own server">
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={draft.ntfy.enabled}
              onChange={(event) => set((current) => ({ ...current, ntfy: { ...current.ntfy, enabled: event.target.checked } }))} />
            Enable ntfy
          </label>
          <label className={`${field} mt-3`} htmlFor="ntfy-server">
            <span className="text-xs text-muted">Server URL</span>
            <input id="ntfy-server" className={input} value={draft.ntfy.server}
              onChange={(event) => set((current) => ({ ...current, ntfy: { ...current.ntfy, server: event.target.value } }))} />
          </label>
          <label className={`${field} mt-2`} htmlFor="ntfy-topic">
            <span className="text-xs text-muted">Topic</span>
            <input id="ntfy-topic" className={input} value={draft.ntfy.topic}
              onChange={(event) => set((current) => ({ ...current, ntfy: { ...current.ntfy, topic: event.target.value } }))} />
          </label>
          <label className={`${field} mt-2`} htmlFor="ntfy-token">
            <span className="text-xs text-muted">Access token (optional, never shown again)</span>
            <input id="ntfy-token" type="password" autoComplete="off" className={input} value={draft.ntfy.token}
              placeholder={draft.ntfy.hasToken ? "saved" : ""}
              onChange={(event) => set((current) => ({ ...current, ntfy: { ...current.ntfy, token: event.target.value } }))} />
          </label>
          <label className="mt-2 flex items-center gap-2 text-xs text-muted">
            <input type="checkbox" checked={remove.ntfy} disabled={!draft.ntfy.hasToken}
              onChange={(event) => setRemove((current) => ({ ...current, ntfy: event.target.checked }))} />
            Remove the saved token
          </label>
          <button type="button" onClick={() => setModal("ntfy-setup")}
            className="mt-3 text-xs px-3 py-1.5 rounded-lg border border-line bg-chip text-ink hover:border-accent">
            Setup instructions
          </button>
        </Card>

        <Card title="Telegram" icon="Users" sub="A bot you own and the chat it posts to">
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={draft.telegram.enabled}
              onChange={(event) => set((current) => ({ ...current, telegram: { ...current.telegram, enabled: event.target.checked } }))} />
            Enable Telegram
          </label>
          <label className={`${field} mt-3`} htmlFor="telegram-token">
            <span className="text-xs text-muted">Bot token (never shown again)</span>
            <input id="telegram-token" type="password" autoComplete="off" className={input} value={draft.telegram.botToken}
              placeholder={draft.telegram.hasToken ? "saved" : ""}
              onChange={(event) => set((current) => ({ ...current, telegram: { ...current.telegram, botToken: event.target.value } }))} />
          </label>
          <label className={`${field} mt-2`} htmlFor="telegram-chat">
            <span className="text-xs text-muted">Chat id</span>
            <input id="telegram-chat" className={input} value={draft.telegram.chatId}
              onChange={(event) => set((current) => ({ ...current, telegram: { ...current.telegram, chatId: event.target.value } }))} />
          </label>
          <label className="mt-2 flex items-center gap-2 text-xs text-muted">
            <input type="checkbox" checked={remove.telegram} disabled={!draft.telegram.hasToken}
              onChange={(event) => setRemove((current) => ({ ...current, telegram: event.target.checked }))} />
            Remove the saved token
          </label>
          <button type="button" onClick={() => setModal("telegram-setup")}
            className="mt-3 text-xs px-3 py-1.5 rounded-lg border border-line bg-chip text-ink hover:border-accent">
            Setup instructions
          </button>
        </Card>
      </div>

      <Card title="Conditions" icon="Clock" sub="Each one needs the master switch above to send anything">
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" className="mt-0.5" checked={draft.conditions.newReset}
              onChange={(event) => set((current) => ({ ...current, conditions: { ...current.conditions, newReset: event.target.checked } }))} />
            <span>New reset announcement<span className="block text-[11px] text-muted">The first feed after this is turned on is a baseline, not an alert.</span></span>
          </label>
          <div>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={draft.conditions.upcoming}
                onChange={(event) => set((current) => ({ ...current, conditions: { ...current.conditions, upcoming: event.target.checked } }))} />
              Officially announced reset coming up
            </label>
            <label className={`${field} mt-2 max-w-48`} htmlFor="lead-minutes">
              <span className="text-xs text-muted">Send this many minutes before (1 to 1440)</span>
              <input id="lead-minutes" type="number" min={1} max={1440} className={input} value={draft.conditions.leadMinutes}
                onChange={(event) => set((current) => ({ ...current, conditions: { ...current.conditions, leadMinutes: Number(event.target.value) } }))} />
            </label>
          </div>
          <div>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={draft.conditions.usage.enabled}
                onChange={(event) => set((current) => ({ ...current, conditions: { ...current.conditions, usage: { ...current.conditions.usage, enabled: event.target.checked } } }))} />
              Subscription usage threshold
            </label>
            <label className={`${field} mt-2 max-w-32`} htmlFor="usage-percent">
              <span className="text-xs text-muted">Percent (1 to 100)</span>
              <input id="usage-percent" type="number" min={1} max={100} className={input} value={draft.conditions.usage.percent}
                onChange={(event) => set((current) => ({ ...current, conditions: { ...current.conditions, usage: { ...current.conditions.usage, percent: Number(event.target.value) } } }))} />
            </label>
          </div>
          <label className={`${field} max-w-56`} htmlFor="usage-provider">
            <span className="text-xs text-muted">Provider</span>
            <select id="usage-provider" className={input} value={draft.conditions.usage.provider}
              onChange={(event) => set((current) => ({ ...current, conditions: { ...current.conditions, usage: { ...current.conditions.usage, provider: event.target.value as PublicSettings["conditions"]["usage"]["provider"] } } }))}>
              {PROVIDERS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
            <span className="mt-1 text-[11px] text-muted">The subscription utilization this report already shows, not token spend.</span>
          </label>
        </div>
      </Card>

      <div className="flex flex-wrap items-center gap-3">
        <button type="button" disabled={busy} onClick={save}
          className="text-xs px-3 py-1.5 bg-accent text-bg font-semibold rounded-lg border border-accent hover:brightness-110 disabled:opacity-50">
          Save settings
        </button>
        <button type="button" disabled={busy || !saved} onClick={test}
          className="text-xs px-3 py-1.5 rounded-lg border border-line bg-chip text-ink hover:border-accent disabled:opacity-50">
          Send a test notification
        </button>
        <p role="status" aria-live="polite" className={`text-xs ${status?.tone === "warn" ? "text-warn" : "text-muted"}`}>
          {status?.text ?? ""}
        </p>
      </div>

      <Modal open={modal === "ntfy-setup"} onClose={() => setModal(null)} title="ntfy setup"
        description="Get phone alerts from your own private topic."
        footer={<button type="button" onClick={() => setModal(null)}
          className="text-xs px-3 py-1.5 rounded-lg border border-line bg-chip text-ink hover:border-accent">Close</button>}>
        <ol className="list-decimal space-y-2 pl-5 text-sm">
          <li>Install the app from <a className="text-accent hover:underline" href="https://ntfy.sh" target="_blank" rel="noreferrer">ntfy.sh</a> (details in the <a className="text-accent hover:underline" href="https://docs.ntfy.sh/subscribe/phone/" target="_blank" rel="noreferrer">official docs</a>) and subscribe it to a unique private topic on your server, for example <code>my-alerts-9f3k</code>. Pick your own unique name, not this example.</li>
          <li>Paste the matching full endpoint here as Server plus Topic, for example server <code>https://ntfy.sh</code> with that same topic. A publicly guessable topic is not private: anyone who guesses the name can read it and post to it.</li>
          <li>For sensitive alerts use an authenticated topic instead: create a user and access token on your server and paste the token below; the topic stays unreadable without it.</li>
          <li>Turn on Send notifications from this server plus Enable ntfy, press Save settings, then Send a test notification and check the phone. Real alerts need the master switch on; the test send works without it.</li>
        </ol>
      </Modal>

      <Modal open={modal === "telegram-setup"} onClose={() => setModal(null)} title="Telegram setup"
        description="Get alerts from a bot you own."
        footer={<button type="button" onClick={() => setModal(null)}
          className="text-xs px-3 py-1.5 rounded-lg border border-line bg-chip text-ink hover:border-accent">Close</button>}>
        <ol className="list-decimal space-y-2 pl-5 text-sm">
          <li>Open the verified <a className="text-accent hover:underline" href="https://t.me/BotFather" target="_blank" rel="noreferrer">@BotFather</a>, send <code>/newbot</code>, and copy the bot token it returns (format <code>123456:ABC-DEF…</code>).</li>
          <li>Open your new bot, tap Start, and send it any message. Then read the chat id with <code>curl 'https://api.telegram.org/bot{"<TOKEN>"}/getUpdates'</code> and copy the <code>result[].message.chat.id</code> number (see the <a className="text-accent hover:underline" href="https://core.telegram.org/bots/api#getupdates" target="_blank" rel="noreferrer">official API</a>). An empty result means no message arrived yet, so send one first; an existing webhook on the bot can also prevent getUpdates from returning anything.</li>
          <li>Paste the chat id and the bot token below. Never paste them anywhere else.</li>
          <li>Turn on Send notifications from this server plus Enable Telegram, press Save settings, then Send a test notification and check the chat. Real alerts need the master switch on; the test send works without it.</li>
        </ol>
      </Modal>
    </div>
  );
}
