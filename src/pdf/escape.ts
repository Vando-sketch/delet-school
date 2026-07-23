/**
 * Neutralizes markdown/pandoc structural syntax in LLM-authored text before it's embedded
 * into a hand-built pandoc document (fenced divs for Frage/Antwort/Quelle blocks). LLM
 * output is not trusted to be syntactically safe for whatever it's interpolated into - same
 * posture as sanitizeBaseName() in nextcloud/writeResult.ts for filenames. Ordinary markdown
 * (bold, lists, balanced inline code) is left alone; only breaks the specific sequences that
 * would corrupt the surrounding pandoc template (stray fence runs, raw HTML, unbalanced code).
 */
export function escapeForPandoc(text: string): string {
  const noRawHtml = text.replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const noFenceRuns = noRawHtml.replace(/:::+/g, (run) => run.split('').join('​'));
  const backtickCount = (noFenceRuns.match(/`/g) ?? []).length;
  return backtickCount % 2 === 0 ? noFenceRuns : `${noFenceRuns}\``;
}
