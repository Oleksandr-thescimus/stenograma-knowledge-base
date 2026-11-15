// A reply draft as it's pasted into the messenger: without its [n] marks, which cite the sources for the review
export const withoutCitations = (text: string) => text
  .replace(/[ \t]*(\[\d{1,3}\])+/g, '')
  .replace(/[ \t]+([.,;:!?])/g, '$1')
  .trim();
