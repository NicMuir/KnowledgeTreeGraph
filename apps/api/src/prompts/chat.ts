import type { SearchResult } from '@kb/shared';

const STALE_THRESHOLD_HOURS = 48;

export function buildChatPrompt(question: string, results: SearchResult[]): string {
  const contextBlocks = results.map((r, i) => {
    const ageHours = (Date.now() - new Date(r.indexedAt).getTime()) / 3_600_000;
    const staleNote = ageHours > STALE_THRESHOLD_HOURS
      ? ` ⚠️ indexed ${Math.round(ageHours / 24)}d ago — may be stale`
      : '';

    return [
      `--- Source ${i + 1} ---`,
      `Repo: ${r.repoName}  File: ${r.filePath}:${r.startLine}-${r.endLine}`,
      `Commit: ${r.commitSha}${staleNote}`,
      `Type: ${r.chunkType}`,
      '',
      r.content,
    ].join('\n');
  }).join('\n\n');

  return `You are a knowledgeable assistant for engineering teams. Answer questions using ONLY the retrieved context below.

Rules:
1. Answer only from the retrieved context. If the answer is not present, say so explicitly.
2. Cite sources using [Source N] notation with the repo, file path, and line range.
3. If context is marked stale (indexed days ago), warn the user and include the commit SHA.
4. Distinguish facts (directly in context) from inferences. Label inferences: "Based on the code, I infer..."
5. If information is missing or partial: "The retrieved context does not contain information about X."
6. Never fabricate code, signatures, or behavior not shown in context.
7. Mention the commit SHA when quoting specific code so readers can verify currency.

Retrieved context:
${contextBlocks}

Question: ${question}

Answer (with citations):`;
}

export const SYSTEM_PROMPT =
  'You are an expert engineering assistant embedded in a multi-repository knowledge base. ' +
  'Always ground your answers in the retrieved context. Be precise about file paths and line numbers. ' +
  'When context may be outdated, say so.';
