import { randomUUID } from 'node:crypto';
import type { TodoItem, TodoStatus } from '../shared/contracts';

/** Per-session todo list, persisted inside the session snapshot. */
export class TodoStore {
  private items: TodoItem[] = [];

  list(): TodoItem[] {
    return this.items.map((t) => ({ ...t }));
  }

  /** Replace the whole list (the write tool semantics). */
  set(items: { id?: string; content: string; status: TodoStatus }[]): TodoItem[] {
    this.items = items.map((t) => ({
      id: t.id ?? `todo_${randomUUID().slice(0, 8)}`,
      content: t.content,
      status: t.status,
    }));
    return this.list();
  }

  restore(items: TodoItem[]): void {
    this.items = items.map((t) => ({ ...t }));
  }
}
