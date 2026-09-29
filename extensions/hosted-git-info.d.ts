declare module "hosted-git-info" {
  interface HostedGitInfo {
    domain?: string;
    user?: string;
    project?: string;
    committish?: string;
  }

  const hostedGitInfo: {
    fromUrl(url: string): HostedGitInfo | undefined;
  };

  export default hostedGitInfo;
}
