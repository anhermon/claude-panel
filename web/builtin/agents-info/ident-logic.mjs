// What an agent IS, as two short labels on every row, tile, callout and gantt bar: its TYPE exactly as Claude Code names it
// (`general-purpose`, `pstack:poteto-agent`, `example-tools:worker`, `Explore`; the namespace is never stripped) and `model:effort`
// (`sonnet:high`; an inherited effort is spelled `high*` by the host; a part nobody knows is left out, never invented). Pure; no DOM.

/** The last characters of a type that are never cut: the name's end (`s:worker`), while the front (`example-tools:`) is what shrinks first when room is short. */
export const TYPE_TAIL_CHARS = 8;

/** The type in two parts, `{ head, tail }`, that join back to the exact name: the page lets the head shrink with an ellipsis, so a name too wide for its place is cut in the MIDDLE and both ends survive. */
export function splitType(text, tailChars = TYPE_TAIL_CHARS) {
  const at = Math.max(0, text.length - tailChars);
  return { head: text.slice(0, at), tail: text.slice(at) };
}

/** The agent type verbatim, or '' (the main session and agents whose type is unknown have none). */
export const typeOf = (agent) => (typeof agent?.agentType === 'string' ? agent.agentType : '');

/** "sonnet:high", "sonnet" or "high*" (what is known); '' when neither is. */
export const modelEffortOf = (agent) => [agent?.model, agent?.effort].filter((x) => typeof x === 'string' && x !== '').join(':');

/** The one line for a tooltip: "example-tools:worker · sonnet:high" (whatever is known). */
export const identLine = (agent) => [typeOf(agent), modelEffortOf(agent)].filter(Boolean).join(' · ');
