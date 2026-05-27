export interface Commit {
  hash: string;
  authorName: string;
  date: string; // ISO 8601
  subject: string;
}
