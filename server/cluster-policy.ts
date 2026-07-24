export function isClusterEnabled(environment: NodeJS.ProcessEnv): boolean {
  return environment.CLUSTER_ENABLED === 'true' || environment.APOLLOON_CLUSTER === 'true';
}
