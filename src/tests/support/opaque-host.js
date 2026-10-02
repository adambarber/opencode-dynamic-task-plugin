/**
 * The one way a test reaches production with a host.
 *
 * Production holds an opaque host, so a suite that hands a raw client to a
 * production function is testing a shape that cannot occur — and it fails at the
 * first mint, in every suite at once. Minting here means the fake goes through the
 * SAME door the plugin entry does, so a test can never accidentally exercise a
 * path production has no way to take.
 */
export { asOpaqueHost as opaqueHost } from "../../../dist/shared/client.js";
