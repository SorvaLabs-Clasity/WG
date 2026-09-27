/**
 * repro-memberview, on an AWS-only account.
 *
 * Its own file so the sweep, which runs every repro-*.ts without arguments,
 * runs this mode too. The server reads its environment when it is imported, so
 * the two modes cannot share a process.
 *
 * Run:  npx tsx repro-awsonlyview.ts   from github-control-hub/backend
 */
process.argv[2] = "aws-only";
void import("./repro-memberview");
