import { EventEmitter } from 'node:events';
import { EventSchema, type BusEvent, type EventType, type Identity } from '../shared/contracts';
import { newEventId } from './identity';

export type BusListener = (evt: BusEvent) => void;

/**
 * The single identity-stamped event bus. Every meaningful action in the system
 * flows through here (HARD SECURITY RULE: one event bus, one audit path).
 *
 * `publish` validates each event against EventSchema, which enforces that all
 * non-`terminal.output` events carry sessionId/runId/agentId. Invalid events
 * are rejected before they can reach the ledger or the renderer.
 */
export class EventBus {
  private emitter = new EventEmitter();

  constructor() {
    // High-frequency terminal output can attach many transient listeners.
    this.emitter.setMaxListeners(100);
  }

  /**
   * Publish an identity-stamped event. Identity may be supplied inline or via
   * the `identity` argument. Returns the validated, normalized event.
   */
  publish(
    type: EventType,
    payload?: unknown,
    identity?: Partial<Identity>,
  ): BusEvent {
    const candidate = {
      id: newEventId(),
      ts: Date.now(),
      type,
      sessionId: identity?.sessionId,
      runId: identity?.runId,
      agentId: identity?.agentId,
      payload,
    };
    const evt = EventSchema.parse(candidate);
    this.emitter.emit('event', evt);
    this.emitter.emit(type, evt);
    return evt;
  }

  on(listener: BusListener): () => void {
    this.emitter.on('event', listener);
    return () => this.emitter.off('event', listener);
  }

  onType(type: EventType, listener: BusListener): () => void {
    this.emitter.on(type, listener);
    return () => this.emitter.off(type, listener);
  }
}
