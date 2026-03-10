import re

with open("backend/src/services/scannerService.ts", "r") as f:
    content = f.read()

start_str = """            if (condition.rules) {"""
end_str = """                const isEnforcedForAdmins = applyingRulesets.some((rs: any) => !rs.bypass_actors || rs.bypass_actors.length === 0);
                if (ruleReqs.enforceAdmins && !isEnforcedForAdmins) {
                  violations.push({ repo, branch, reason: "Ruleset missing enforce admins requirement (allows bypass)" });
                  isRepoCompliant = false;
                }
              }
            }"""

start_idx = content.find(start_str)
end_idx = content.find(end_str) + len(end_str)

if start_idx == -1 or end_idx < len(end_str):
    print("Could not find the block to replace")
    exit(1)

new_block = """            if (condition.rules && condition.ruleMatchType !== "any") {
              const ruleReqs = condition.rules;
              const isExact = condition.ruleMatchType === "exact";
              
              if (hasClassic) {
                const p = classicProtections[branch] as any;
                const hasPr = !!p.required_pull_request_reviews;
                const hasStatusChecks = !!p.required_status_checks;
                const hasSignedCommits = !!p.required_signatures?.enabled;
                const hasLinearHistory = !!p.required_linear_history?.enabled;
                const hasEnforceAdmins = !!p.enforce_admins?.enabled;
                const preventsForcePush = !p.allow_force_pushes?.enabled;
                const preventsDeletion = !p.allow_deletions?.enabled;

                if (ruleReqs.requirePr && !hasPr) {
                  violations.push({ repo, branch, reason: "Classic protection missing PR requirement" });
                  isRepoCompliant = false;
                } else if (isExact && !ruleReqs.requirePr && hasPr) {
                  violations.push({ repo, branch, reason: "Classic protection has PR requirement (not expected in exact match)" });
                  isRepoCompliant = false;
                }

                if (hasPr) {
                  if (ruleReqs.requirePr) {
                    if (ruleReqs.minApprovals && p.required_pull_request_reviews.required_approving_review_count < ruleReqs.minApprovals) {
                      violations.push({ repo, branch, reason: `Classic protection requires ${p.required_pull_request_reviews.required_approving_review_count} approvals, expected >= ${ruleReqs.minApprovals}` });
                      isRepoCompliant = false;
                    } else if (isExact && ruleReqs.minApprovals && p.required_pull_request_reviews.required_approving_review_count > ruleReqs.minApprovals) {
                      violations.push({ repo, branch, reason: `Classic protection requires ${p.required_pull_request_reviews.required_approving_review_count} approvals, expected exactly ${ruleReqs.minApprovals}` });
                      isRepoCompliant = false;
                    }

                    if (ruleReqs.dismissStaleReviews && !p.required_pull_request_reviews.dismiss_stale_reviews) {
                      violations.push({ repo, branch, reason: "Classic protection missing dismiss stale reviews requirement" });
                      isRepoCompliant = false;
                    } else if (isExact && !ruleReqs.dismissStaleReviews && p.required_pull_request_reviews.dismiss_stale_reviews) {
                      violations.push({ repo, branch, reason: "Classic protection has dismiss stale reviews requirement (not expected in exact match)" });
                      isRepoCompliant = false;
                    }

                    if (ruleReqs.requireCodeOwnerReviews && !p.required_pull_request_reviews.require_code_owner_reviews) {
                      violations.push({ repo, branch, reason: "Classic protection missing code owner reviews requirement" });
                      isRepoCompliant = false;
                    } else if (isExact && !ruleReqs.requireCodeOwnerReviews && p.required_pull_request_reviews.require_code_owner_reviews) {
                      violations.push({ repo, branch, reason: "Classic protection has code owner reviews requirement (not expected in exact match)" });
                      isRepoCompliant = false;
                    }
                  }
                }

                if (ruleReqs.requireStatusChecks && !hasStatusChecks) {
                  violations.push({ repo, branch, reason: "Classic protection missing status checks requirement" });
                  isRepoCompliant = false;
                } else if (isExact && !ruleReqs.requireStatusChecks && hasStatusChecks) {
                  violations.push({ repo, branch, reason: "Classic protection has status checks requirement (not expected in exact match)" });
                  isRepoCompliant = false;
                }

                if (ruleReqs.requireConversationResolution && !p.required_conversation_resolution?.enabled) {
                  violations.push({ repo, branch, reason: "Classic protection missing conversation resolution requirement" });
                  isRepoCompliant = false;
                } else if (isExact && !ruleReqs.requireConversationResolution && p.required_conversation_resolution?.enabled) {
                  violations.push({ repo, branch, reason: "Classic protection has conversation resolution requirement (not expected in exact match)" });
                  isRepoCompliant = false;
                }

                if (hasStatusChecks) {
                  if (ruleReqs.requireStatusChecks) {
                    if (ruleReqs.strictStatusChecks && !p.required_status_checks.strict) {
                      violations.push({ repo, branch, reason: "Classic protection missing strict status checks requirement" });
                      isRepoCompliant = false;
                    } else if (isExact && !ruleReqs.strictStatusChecks && p.required_status_checks.strict) {
                      violations.push({ repo, branch, reason: "Classic protection has strict status checks requirement (not expected in exact match)" });
                      isRepoCompliant = false;
                    }
                  }
                }

                if (ruleReqs.requireSignedCommits && !hasSignedCommits) {
                  violations.push({ repo, branch, reason: "Classic protection missing signed commits requirement" });
                  isRepoCompliant = false;
                } else if (isExact && !ruleReqs.requireSignedCommits && hasSignedCommits) {
                  violations.push({ repo, branch, reason: "Classic protection has signed commits requirement (not expected in exact match)" });
                  isRepoCompliant = false;
                }

                if (ruleReqs.requireLinearHistory && !hasLinearHistory) {
                  violations.push({ repo, branch, reason: "Classic protection missing linear history requirement" });
                  isRepoCompliant = false;
                } else if (isExact && !ruleReqs.requireLinearHistory && hasLinearHistory) {
                  violations.push({ repo, branch, reason: "Classic protection has linear history requirement (not expected in exact match)" });
                  isRepoCompliant = false;
                }

                if (ruleReqs.enforceAdmins && !hasEnforceAdmins) {
                  violations.push({ repo, branch, reason: "Classic protection missing enforce admins requirement" });
                  isRepoCompliant = false;
                } else if (isExact && !ruleReqs.enforceAdmins && hasEnforceAdmins) {
                  violations.push({ repo, branch, reason: "Classic protection has enforce admins requirement (not expected in exact match)" });
                  isRepoCompliant = false;
                }

                if (ruleReqs.preventForcePush && !preventsForcePush) {
                  violations.push({ repo, branch, reason: "Classic protection allows force pushing" });
                  isRepoCompliant = false;
                } else if (isExact && !ruleReqs.preventForcePush && preventsForcePush) {
                  violations.push({ repo, branch, reason: "Classic protection prevents force pushing (not expected in exact match)" });
                  isRepoCompliant = false;
                }

                if (ruleReqs.preventDeletion && !preventsDeletion) {
                  violations.push({ repo, branch, reason: "Classic protection allows branch deletion" });
                  isRepoCompliant = false;
                } else if (isExact && !ruleReqs.preventDeletion && preventsDeletion) {
                  violations.push({ repo, branch, reason: "Classic protection prevents branch deletion (not expected in exact match)" });
                  isRepoCompliant = false;
                }
              } else if (hasRuleset) {
                const allRules = applyingRulesets.flatMap((rs: any) => rs.rules || []);
                const hasRule = (type: string) => allRules.some((r: any) => r.type === type);
                const getRule = (type: string) => allRules.find((r: any) => r.type === type);

                const hasPr = hasRule('pull_request');
                const hasStatusChecks = hasRule('required_status_checks');
                const hasSignedCommits = hasRule('required_signatures');
                const hasLinearHistory = hasRule('required_linear_history');
                const preventsForcePush = hasRule('non_fast_forward');
                const preventsDeletion = hasRule('deletion');
                const isEnforcedForAdmins = applyingRulesets.some((rs: any) => !rs.bypass_actors || rs.bypass_actors.length === 0 || !rs.bypass_actors.some((ba: any) => ba.actor_type === "RepositoryRole" && ba.repository_role_id === 1 && ba.bypass_mode === "always"));

                if (ruleReqs.requirePr && !hasPr) {
                  violations.push({ repo, branch, reason: "Ruleset missing PR requirement" });
                  isRepoCompliant = false;
                } else if (isExact && !ruleReqs.requirePr && hasPr) {
                  violations.push({ repo, branch, reason: "Ruleset has PR requirement (not expected in exact match)" });
                  isRepoCompliant = false;
                }

                if (hasPr) {
                  if (ruleReqs.requirePr) {
                    const prRule = getRule('pull_request');
                    if (ruleReqs.minApprovals && (prRule.parameters?.required_approving_review_count || 0) < ruleReqs.minApprovals) {
                      violations.push({ repo, branch, reason: `Ruleset requires ${prRule.parameters?.required_approving_review_count || 0} approvals, expected >= ${ruleReqs.minApprovals}` });
                      isRepoCompliant = false;
                    } else if (isExact && ruleReqs.minApprovals && (prRule.parameters?.required_approving_review_count || 0) > ruleReqs.minApprovals) {
                      violations.push({ repo, branch, reason: `Ruleset requires ${prRule.parameters?.required_approving_review_count || 0} approvals, expected exactly ${ruleReqs.minApprovals}` });
                      isRepoCompliant = false;
                    }

                    if (ruleReqs.dismissStaleReviews && !prRule.parameters?.dismiss_stale_reviews_on_push) {
                      violations.push({ repo, branch, reason: "Ruleset missing dismiss stale reviews requirement" });
                      isRepoCompliant = false;
                    } else if (isExact && !ruleReqs.dismissStaleReviews && prRule.parameters?.dismiss_stale_reviews_on_push) {
                      violations.push({ repo, branch, reason: "Ruleset has dismiss stale reviews requirement (not expected in exact match)" });
                      isRepoCompliant = false;
                    }

                    if (ruleReqs.requireCodeOwnerReviews && !prRule.parameters?.require_code_owner_review) {
                      violations.push({ repo, branch, reason: "Ruleset missing code owner reviews requirement" });
                      isRepoCompliant = false;
                    } else if (isExact && !ruleReqs.requireCodeOwnerReviews && prRule.parameters?.require_code_owner_review) {
                      violations.push({ repo, branch, reason: "Ruleset has code owner reviews requirement (not expected in exact match)" });
                      isRepoCompliant = false;
                    }

                    if (ruleReqs.requireConversationResolution && !prRule.parameters?.required_review_thread_resolution) {
                      violations.push({ repo, branch, reason: "Ruleset missing conversation resolution requirement" });
                      isRepoCompliant = false;
                    } else if (isExact && !ruleReqs.requireConversationResolution && prRule.parameters?.required_review_thread_resolution) {
                      violations.push({ repo, branch, reason: "Ruleset has conversation resolution requirement (not expected in exact match)" });
                      isRepoCompliant = false;
                    }
                  }
                }

                if (ruleReqs.requireStatusChecks && !hasStatusChecks) {
                  violations.push({ repo, branch, reason: "Ruleset missing status checks requirement" });
                  isRepoCompliant = false;
                } else if (isExact && !ruleReqs.requireStatusChecks && hasStatusChecks) {
                  violations.push({ repo, branch, reason: "Ruleset has status checks requirement (not expected in exact match)" });
                  isRepoCompliant = false;
                }

                if (hasStatusChecks) {
                  if (ruleReqs.requireStatusChecks) {
                    const statusRule = getRule('required_status_checks');
                    if (ruleReqs.strictStatusChecks && !statusRule.parameters?.strict_required_status_checks_policy) {
                      violations.push({ repo, branch, reason: "Ruleset missing strict status checks requirement" });
                      isRepoCompliant = false;
                    } else if (isExact && !ruleReqs.strictStatusChecks && statusRule.parameters?.strict_required_status_checks_policy) {
                      violations.push({ repo, branch, reason: "Ruleset has strict status checks requirement (not expected in exact match)" });
                      isRepoCompliant = false;
                    }
                  }
                }

                if (ruleReqs.requireSignedCommits && !hasSignedCommits) {
                  violations.push({ repo, branch, reason: "Ruleset missing signed commits requirement" });
                  isRepoCompliant = false;
                } else if (isExact && !ruleReqs.requireSignedCommits && hasSignedCommits) {
                  violations.push({ repo, branch, reason: "Ruleset has signed commits requirement (not expected in exact match)" });
                  isRepoCompliant = false;
                }

                if (ruleReqs.requireLinearHistory && !hasLinearHistory) {
                  violations.push({ repo, branch, reason: "Ruleset missing linear history requirement" });
                  isRepoCompliant = false;
                } else if (isExact && !ruleReqs.requireLinearHistory && hasLinearHistory) {
                  violations.push({ repo, branch, reason: "Ruleset has linear history requirement (not expected in exact match)" });
                  isRepoCompliant = false;
                }

                if (ruleReqs.preventForcePush && !preventsForcePush) {
                  violations.push({ repo, branch, reason: "Ruleset allows force pushing" });
                  isRepoCompliant = false;
                } else if (isExact && !ruleReqs.preventForcePush && preventsForcePush) {
                  violations.push({ repo, branch, reason: "Ruleset prevents force pushing (not expected in exact match)" });
                  isRepoCompliant = false;
                }

                if (ruleReqs.preventDeletion && !preventsDeletion) {
                  violations.push({ repo, branch, reason: "Ruleset allows branch deletion" });
                  isRepoCompliant = false;
                } else if (isExact && !ruleReqs.preventDeletion && preventsDeletion) {
                  violations.push({ repo, branch, reason: "Ruleset prevents branch deletion (not expected in exact match)" });
                  isRepoCompliant = false;
                }

                if (ruleReqs.enforceAdmins && !isEnforcedForAdmins) {
                  violations.push({ repo, branch, reason: "Ruleset does not enforce rules for admins" });
                  isRepoCompliant = false;
                } else if (isExact && !ruleReqs.enforceAdmins && isEnforcedForAdmins) {
                  violations.push({ repo, branch, reason: "Ruleset enforces rules for admins (not expected in exact match)" });
                  isRepoCompliant = false;
                }
              }
            }"""

new_content = content[:start_idx] + new_block + content[end_idx:]

with open("backend/src/services/scannerService.ts", "w") as f:
    f.write(new_content)
print("Updated scannerService.ts")
