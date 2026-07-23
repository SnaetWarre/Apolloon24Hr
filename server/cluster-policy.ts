import type { ClusterRole } from '../shared/schemas.js';

export function isClusterEnabled(environment: NodeJS.ProcessEnv): boolean {
  return environment.CLUSTER_ENABLED === 'true' || environment.APOLLOON_CLUSTER === 'true';
}

export function shouldAcceptRemoteLeader(input: {
  currentTerm: number;
  remoteTerm: number;
  role: ClusterRole;
  hostId: string | null;
  leaderId: string | null;
  remoteLeaderId: string;
}): boolean {
  if (input.remoteTerm > input.currentTerm) return true;
  if (input.remoteTerm < input.currentTerm) return false;
  if (input.remoteLeaderId === input.leaderId) return true;

  const incumbentId = input.role === 'leader' ? input.hostId : input.leaderId;
  if (!incumbentId) return true;
  return input.remoteLeaderId < incumbentId;
}

export function shouldGrantVote(input: {
  candidateTerm: number;
  currentTerm: number;
  currentLeaderId: string | null;
  candidateId: string;
  votedFor: string | null;
  candidateIsCaughtUp: boolean;
}): boolean {
  if (input.candidateTerm < input.currentTerm) return false;
  if (
    input.candidateTerm === input.currentTerm &&
    input.currentLeaderId &&
    input.currentLeaderId !== input.candidateId
  ) {
    return false;
  }
  return input.candidateIsCaughtUp && (!input.votedFor || input.votedFor === input.candidateId);
}
