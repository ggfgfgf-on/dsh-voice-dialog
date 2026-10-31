/**
 * Types for the vendored speech Remote contribution.
 *
 * The .js file is generated from the host FaceModel; the client mounts it
 * through ctx.remote.$mount, so its shape is the protocol's contribution, not
 * a hand-written interface.
 */
import type { TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'

declare const speechRemote: TypertRemoteContribution
export default speechRemote
