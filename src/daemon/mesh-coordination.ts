export const MESH_PACKET_MAX_LINES = 8;

export interface MeshPacketParts {
  from: string;
  to: string;
  targetBirthId?: string;
  purpose: string;
  repo?: string;
  branch?: string;
  commit?: string;
  state?: string;
  task?: string;
  ask?: string;
}

export interface MeshPacketValidation {
  ok: boolean;
  lineCount: number;
  reasons: string[];
}

function meaningfulLines(text: string): string[] {
  return text
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

export function formatMeshPacket(parts: MeshPacketParts): string {
  const birth = parts.targetBirthId ? ` birth_id=${parts.targetBirthId}` : '';
  const lines = [`[${parts.from} -> ${parts.to}${birth}] ${parts.purpose}`];
  if (parts.repo || parts.branch || parts.commit) {
    lines.push(`repo=${parts.repo ?? '-'} branch=${parts.branch ?? '-'} commit=${parts.commit ?? '-'}`);
  }
  if (parts.state) lines.push(`state=${parts.state}`);
  if (parts.task) lines.push(`task=${parts.task}`);
  if (parts.ask) lines.push(`ask=${parts.ask}`);
  return lines.join('\n');
}

export function validateMeshPacket(text: string): MeshPacketValidation {
  const lines = meaningfulLines(text);
  const reasons: string[] = [];
  if (lines.length === 0) reasons.push('empty packet');
  if (lines.length > MESH_PACKET_MAX_LINES) {
    reasons.push(`too many lines: ${lines.length} > ${MESH_PACKET_MAX_LINES}`);
  }
  if (lines.length > 0 && !/^\[[A-Za-z0-9_-]+ -> [A-Za-z0-9_-]+(?: birth_id=[^\]]+)?\]/.test(lines[0])) {
    reasons.push('missing mesh header');
  }
  if (/expect (codex|claude|gemini|ron) to scrape/i.test(text)) {
    reasons.push('local narration is not a transport reply');
  }
  return { ok: reasons.length === 0, lineCount: lines.length, reasons };
}

export function meshProtocolText(): string {
  return [
    'Mesh protocol:',
    '  replies travel over SelfConnect transport into the target agent terminal',
    '  local output after send is only SENT, ACK, or one-line blocker',
    `  packets stay <=${MESH_PACKET_MAX_LINES} lines unless the receiver asks`,
    '  use birth_id + hwnd/pid/exe/class/title guard before sending',
    '  update mesh registry instead of narrating state',
    '  normal mode stays fast; enterprise/government controls are profile-gated',
  ].join('\n');
}
