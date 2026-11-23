// The Containerfile, the skill-sync script and the browser wrapper are
// embedded at build time.
declare module "*Containerfile" {
  const content: string;
  export default content;
}

declare module "*skill-sync.sh" {
  const content: string;
  export default content;
}

declare module "*chromium.sh" {
  const content: string;
  export default content;
}
