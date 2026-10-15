type RecordValue = Record<string, unknown>;

function asRecord(value: unknown): RecordValue | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function names(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

export function findLatestGateEvent(contents: string, sessionId: string, promptSha256: string): RecordValue | null {
  const lines = contents.split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (!lines[index]?.trim()) continue;
    try {
      const event = asRecord(JSON.parse(lines[index]!));
      if (
        event?.event_type === "gate_decision" &&
        event.session_id === sessionId &&
        event.prompt_sha256 === promptSha256
      ) return event;
    } catch {
      // Ignore an incomplete final line or an unrelated malformed record.
    }
  }
  return null;
}

export function formatGateFooter(event: RecordValue): string {
  const status = typeof event.gate_status === "string" ? event.gate_status : "unknown";
  const probability = finiteNumber(event.probability);
  const threshold = finiteNumber(event.threshold);
  const candidateNames = names(event.candidate_names);
  const injectedNames = names(event.injected_skill_names);
  const ranking = Array.isArray(event.candidate_rankings) ? event.candidate_rankings.map(asRecord).filter((item): item is RecordValue => Boolean(item)) : [];
  const top = ranking.slice(0, 2).map((item) => {
    const name = typeof item.name === "string" ? item.name : "?";
    const score = finiteNumber(item.search_score);
    return `${name.slice(0, 14)}${name.length > 14 ? "…" : ""}${score === null ? "" : ` ${score.toFixed(1)}`}`;
  });
  const tokenText = finiteNumber(event.input_tokens) !== null
    ? `${finiteNumber(event.input_tokens)} tok`
    : event.request_attempted === true && finiteNumber(event.estimated_input_tokens) !== null
      ? `~${finiteNumber(event.estimated_input_tokens)} tok`
      : event.request_attempted === false ? "not sent" : "tokens n/a";
  const cost = finiteNumber(event.jev_list_cost_usd);
  const costText = cost !== null
    ? `${event.cost_basis === "estimated_input_tokens" ? "~" : ""}$${cost.toFixed(8)}`
    : event.request_attempted === false ? "" : "cost n/a";
  const jevText = probability !== null
    ? `Jev ${probability.toFixed(2)}${threshold === null ? "" : `/${threshold.toFixed(2)}`}`
    : status === "bypassed" ? "gate off"
      : status === "no_candidates" ? "no Jev call"
        : status === "search_error" ? "search error" : `Jev ${status}`;
  const topText = top.length ? ` · search: ${top.join(", ")}` : "";
  const costSuffix = costText ? ` · ${costText}` : "";
  return `SG ${status} · ${jevText} · ${candidateNames.length}→${injectedNames.length} · ${tokenText}${costSuffix}${topText}`;
}

export function formatGateDetails(
  event: RecordValue,
  requestBody: unknown | null,
  candidatesMatch: boolean,
): string {
  const status = typeof event.gate_status === "string" ? event.gate_status : "unknown";
  const probability = finiteNumber(event.probability);
  const threshold = finiteNumber(event.threshold);
  const rankings = Array.isArray(event.candidate_rankings) ? event.candidate_rankings.map(asRecord).filter((item): item is RecordValue => Boolean(item)) : [];
  const injected = names(event.injected_skill_names);
  const inputTokens = finiteNumber(event.input_tokens);
  const outputTokens = finiteNumber(event.output_tokens);
  const estimate = finiteNumber(event.estimated_input_tokens);
  const listCost = finiteNumber(event.jev_list_cost_usd);
  const priceRate = finiteNumber(event.cost_rate_usd_per_million_input_tokens);
  const costBasis = event.cost_basis === "estimated_input_tokens" ? "estimated from request size" : "reported input-token usage";
  const priceSource = typeof event.cost_rate_source === "string" ? event.cost_rate_source : "https://docs.typesafe.ai/models.md";
  const usage = inputTokens !== null ? `${inputTokens} input tokens reported by Jev` : estimate !== null
    ? `about ${estimate} input tokens (4 bytes/token estimate; not provider-reported)` : "input-token usage unavailable";
  const costDetails = listCost !== null
    ? `${event.cost_basis === "estimated_input_tokens" ? "about " : ""}$${listCost.toFixed(8)} at $${priceRate?.toFixed(3) ?? "0.042"} per million input tokens; output tokens are free (${costBasis}). This is calculated list cost, not an invoice line.`
    : event.request_attempted === false ? "No Jev cost; no request was sent." : "Jev cost unavailable.";
  const bodyText = requestBody === null ? null : JSON.stringify(requestBody, null, 2);
  const displayedBody = bodyText && bodyText.length > 16_000
    ? `${bodyText.slice(0, 16_000)}\n… [viewer truncated; event metrics are exact]`
    : bodyText;
  const lines = [
    "Skill Gateway — Jev any_skill gate",
    `Decision: ${status}${probability === null ? "" : ` · p=${probability.toFixed(3)} · threshold=${threshold?.toFixed(2) ?? "n/a"}`}`,
    `Injected: ${injected.length ? injected.join(", ") : "none"}`,
    `Request attempted: ${event.request_attempted === true ? "yes" : "no"}`,
    `Usage: ${usage}${outputTokens === null ? "" : ` · ${outputTokens} output tokens`}`,
    `Jev cost: ${costDetails}`,
    `Price source: ${priceSource}`,
    `Request body: ${finiteNumber(event.request_body_bytes) ?? "n/a"} bytes · state ${finiteNumber(event.state_characters) ?? "n/a"} chars`,
    "Retrieval order (local search scores; Jev returns one shortlist-level probability, not per-skill scores):",
    ...(rankings.length ? rankings.map((item, index) => `  ${index + 1}. ${String(item.name ?? "?")} · ${finiteNumber(item.search_score)?.toFixed(3) ?? "score n/a"}`) : ["  no candidates"]),
    candidatesMatch ? "Candidate names/order match the recorded shortlist; descriptions below are reconstructed from the current local library." : "Warning: current local candidate names/order differ from the recorded shortlist; request body below is omitted.",
    displayedBody !== null
      ? `${event.request_attempted === true ? "Request body" : "Would-be request body (not sent)"} (authorization header omitted):\n${displayedBody}`
      : event.request_attempted === true
        ? "A Jev request was attempted, but the body reconstruction was omitted because candidate names/order did not match."
        : "No request body was sent or reconstructed for this turn.",
  ];
  return lines.join("\n");
}
