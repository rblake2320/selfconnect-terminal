export const JEV_STATUS = {
  error: 'Error reported', waiting: 'Waiting for your input', running: 'Work in progress',
  success: 'Success reported in output', idle: 'Shell ready', unknown: 'Unclear from this output',
} as const;
export const JEV_ACTIONS = {
  check_path: 'Check the file path and current folder shown in the error.',
  check_dependency: 'Check whether the named command or dependency is installed in this environment.',
  check_connection: 'Check the named service, connection, or authentication setting.',
  review_failure: 'Read the failing assertion or error above before changing or rerunning anything.',
  answer_prompt: 'Read the prompt in the terminal and supply the requested input yourself.',
  verify_result: 'Inspect the resulting file or run the relevant check before treating the task as complete.',
  wait: 'Let the active operation continue; refresh the snapshot when it produces more output.',
  inspect_more: 'Inspect more output or clarify the current task before choosing an action.',
} as const;
export interface JevSnapshot {
  id: string; sessionId: string; capturedAt: number; text: string; hash: string;
  redactions: number; configured: boolean;
}
export interface JevAnalysis {
  snapshotId: string; sessionId: string; capturedAt: number; hash: string;
  status: keyof typeof JEV_STATUS; action: keyof typeof JEV_ACTIONS;
  statusConfidence: number; actionConfidence: number; uncertain: boolean;
  model: string; inputTokens: number; outputTokens: number; elapsedMs: number; cached: boolean;
}
