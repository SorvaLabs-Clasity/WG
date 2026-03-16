import { Octokit } from "octokit";

async function run() {
  const octokit = new Octokit({ auth: process.env.SYSTEM_GITHUB_TOKEN || process.env.GITHUB_TOKEN });
  const org = process.env.GITHUB_ORG;
  
  const query = `
    query($org: String!, $cursor: String) {
      organization(login: $org) {
        repositories(first: 100, after: $cursor) {
          pageInfo {
            hasNextPage
            endCursor
          }
          nodes {
            name
            hasVulnerabilityAlertsEnabled
          }
        }
      }
    }
  `;
  
  try {
    const res: any = await octokit.graphql(query, { org, cursor: null });
    console.log(JSON.stringify(res.organization.repositories.nodes, null, 2));
  } catch (err) {
    console.error(err);
  }
}

run();
