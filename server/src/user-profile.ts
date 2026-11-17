import { db } from './db.js';

export function displayNameFor(userId: string): string {
  const user = db.prepare('SELECT display_name FROM users WHERE id=?').get(userId) as { display_name: string } | undefined;
  return user?.display_name?.trim() || 'user';
}
