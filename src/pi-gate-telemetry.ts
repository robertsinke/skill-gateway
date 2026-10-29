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
        event.gate_status !== "not_evaluated" &&
        event.session_id === sessionId &&
        event.prompt_sha256 === promptSha256
      ) return event;
    } catch {
      // Ignore an incomplete final line or an unrelated malformed record.
    }
  }
  return null;
}

export function sumRecordedGateCosts(contents: string): { total: number; includes_estimates: boolean } {
  let total = 0;
  let includes_estimates = false;
  for (const line of contents.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const event = asRecord(JSON.parse(line));
      const isGate = event?.event_type === "gate_decision";
      const isRerank = event?.event_type === "skill_rerank_shadow" || event?.event_type === "skill_rerank_experiment";
      const cost = finiteNumber(isGate ? event.jev_list_cost_usd : isRerank ? event.cost_usd : null);
      if ((!isGate && !isRerank) || cost === null || cost < 0) continue;
      total += cost;
      if (event.cost_basis === "estimated_input_tokens" || (isRerank && event.input_tokens == null && event.request_attempted === true)) includes_estimates = true;
    } catch {
      // Ignore incomplete or malformed log lines.
    }
  }
  return { total, includes_estimates };
}

type CumulativeGateCost = { total: number; includes_estimates: boolean };

function recordedLogTotalLabel(cumulativeCost?: CumulativeGateCost | null): string {
  if (!cumulativeCost) return "total n/a";
  return `total ${cumulativeCost.includes_estimates ? "~" : ""}$${cumulativeCost.total.toFixed(8)}`;
}

export function formatGateFooter(event: RecordValue, cumulativeCost?: CumulativeGateCost | null): string {
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
  const jevText = probability !== null
    ? `Jev ${probability.toFixed(2)}${threshold === null ? "" : `/${threshold.toFixed(2)}`}`
    : status === "not_evaluated" ? "gate not evaluated"
      : status === "bypassed" ? "gate off"
        : status === "no_candidates" ? "no Jev call"
          : status === "search_error" ? "search error" : `Jev ${status}`;
  const topText = top.length ? ` · search: ${top.join(", ")}` : "";
  const cumulativeText = ` · ${recordedLogTotalLabel(cumulativeCost)}`;
  const arm = event.experiment_arm === "treatment" ? ` · rerank ${names(event.rerank_selected_names).length}/${candidateNames.length}`
    : event.experiment_arm === "control" ? " · rerank control" : "";
  return `SG ${status} · ${jevText} · ${candidateNames.length}→${injectedNames.length} · ${tokenText}${cumulativeText}${arm}${topText}`;
}

export function formatGateDetails(
  event: RecordValue,
  requestBody: unknown | null,
  candidatesMatch: boolean,
  cumulativeCost?: CumulativeGateCost | null,
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
    ...(event.experiment_arm ? [`Experiment arm: ${event.experiment_arm}${event.experiment_arm === "treatment" ? ` · rerank selected ${names(event.rerank_selected_names).join(", ") || "none"}` : ""}`] : []),
    `Request attempted: ${event.request_attempted === true ? "yes" : "no"}`,
    `Usage: ${usage}${outputTokens === null ? "" : ` · ${outputTokens} output tokens`}`,
    `Jev cost: ${costDetails}`,
    ...(cumulativeCost !== undefined ? [recordedLogTotalLine(cumulativeCost)] : []),
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

function recordedLogTotalLine(cumulativeCost: CumulativeGateCost | null): string {
  if (!cumulativeCost) return "Recorded log total: unavailable.";
  const amount = `${cumulativeCost.includes_estimates ? "~" : ""}$${cumulativeCost.total.toFixed(8)}`;
  const estimate = cumulativeCost.includes_estimates ? " A tilde means at least one included cost was estimated." : "";
  return `Recorded log total: ${amount} across gate and rerank requests in the local usage-event log.${estimate}`;
}
