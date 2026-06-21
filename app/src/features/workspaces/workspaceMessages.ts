import {
  createMessage,
  type FilesListRequestPayload,
  type FilesReadRequestPayload,
  type FilesWriteRequestPayload,
  type GitDiffRequestPayload,
  type GitStatusRequestPayload,
} from "@omniwork/protocol-ts";

export function listWorkspacesRequest(deviceId: string) {
  return createMessage("workspace.list", {}, { device_id: deviceId });
}

export function listFilesRequest(
  deviceId: string,
  payload: FilesListRequestPayload,
) {
  return createMessage("files.list", payload, { device_id: deviceId });
}

export function readFileRequest(
  deviceId: string,
  payload: FilesReadRequestPayload,
) {
  return createMessage("files.read", payload, { device_id: deviceId });
}

export function writeFileRequest(
  deviceId: string,
  payload: FilesWriteRequestPayload,
) {
  return createMessage("files.write", payload, { device_id: deviceId });
}

export function gitStatusRequest(
  deviceId: string,
  payload: GitStatusRequestPayload,
) {
  return createMessage("git.status", payload, { device_id: deviceId });
}

export function gitDiffRequest(
  deviceId: string,
  payload: GitDiffRequestPayload,
) {
  return createMessage("git.diff", payload, { device_id: deviceId });
}
