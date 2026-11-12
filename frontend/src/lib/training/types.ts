/**
 * Training course content. A course is plain data: the Training page renders it, the backend
 * (app/api/training.py COURSES) only knows the module ids. Add a course in both places.
 */
export interface Video { id: string; url: string; title: string; meta: string; why: string }

export type Block =
  | { kind: 'videos'; videos: Video[] }
  | { kind: 'text'; title?: string; paragraphs: string[] }
  | { kind: 'list'; title?: string; items: string[] }
  | { kind: 'cards'; title?: string; cards: { title: string; text: string; big?: string }[] }
  | { kind: 'compare'; title?: string; no: { title: string; items: string[] }; yes: { title: string; items: string[] } }
  | { kind: 'ladder'; rungs: { level: string; who: string; role: string; text: string }[] }
  | { kind: 'callout'; label: string; text: string; tone?: 'note' | 'danger' };

export interface Check { tag?: string; q: string; options: string[]; correct: number; explain: string }

export interface Module { id: string; title: string; mins: number; lede: string; blocks: Block[]; checks: Check[] }

export interface Course {
  id: string;
  title: string;
  summary: string;
  audience: string;
  modules: Module[];
  /** Shown on the course start page and when someone finishes. */
  pocketCard: { title: string; items: string[]; ordered?: boolean }[];
}
