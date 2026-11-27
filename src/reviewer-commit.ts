export function isReviewerCommitMessageForIssue(
  commitSubject: string,
  issueId: string
): boolean {
  const trimmedSubject = commitSubject.trim();
  const expectedPrefix = `sandcastle(reviewer): #${issueId}:`;

  return trimmedSubject.startsWith(expectedPrefix);
}
