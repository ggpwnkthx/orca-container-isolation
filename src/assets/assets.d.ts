// The Containerfile and the skill-sync script are embedded at build time.
declare module "*Containerfile" {
  const content: string;
  export default content;
}

declare module "*skill-sync.sh" {
  const content: string;
  export default content;
}
