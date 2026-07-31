export function isReviewerCommitMessageForIssue(
  commitSubject: string,
  issueId: string
): boolean {
  const trimmedSubject = commitSubject.trim();
  const expectedPrefix = `sandcastle(reviewer): #${issueId}:`;

  return trimmedSubject.startsWith(expectedPrefix);
}

export function shouldJumpToMergerAfterReuseForSpec(
  commitSubject: string,
  issueId: string
): boolean {
  return isReviewerCommitMessageForIssue(commitSubject, issueId);
}

export function shouldJumpToMergerAfterReuseForStandalone(
  commitSubject: string,
  issueId: string
): boolean {
  return isReviewerCommitMessageForIssue(commitSubject, issueId);
}
