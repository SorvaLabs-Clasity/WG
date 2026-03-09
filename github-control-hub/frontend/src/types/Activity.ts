export type ActivityAction =
  | "branch.create"
  | "branch.delete"
  | "branch.protect"
  | "template.apply"
  | "template.create"
  | "template.update"
  | "template.delete";

export interface Activity {
  id: string;
  action: ActivityAction;
  actor: string;
  repo: string;
  target: string;
  details?: string;
  diff?: any;
  timestamp: string;
}
