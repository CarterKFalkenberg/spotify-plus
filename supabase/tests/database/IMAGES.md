# Synthetic test images

The standalone fast-tagging harness uses Supabase's public GHCR PostgREST
`v16.4` image pinned to multi-architecture manifest digest
`sha256:d155c6718ed9a9f990d159a2ab7c0a3f16944dbb6d0a0344557421042acfe0df`.
This replaces the same version's ECR reference after ECR rejected CI downloads
with `Data limit exceeded` ([issue #59](https://github.com/CarterKFalkenberg/spotify-plus/issues/59)).
It needs no registry login, cache warm-up, extra CI permissions or paid service.
A GHCR failure still fails the check; no SQL or REST assertion is skipped.

## Provenance checked October 18, 2026

- Supabase's [public PostgREST package](https://github.com/supabase/cli/pkgs/container/postgrest)
  documents `ghcr.io/supabase/postgrest:v16.4` and both Linux architectures.
- The pinned CLI release's [official mirroring workflow](https://github.com/supabase/cli/blob/v2.120.0/.github/workflows/cli-go-mirror-image.yml)
  copies one source image to ECR and GHCR using `docker buildx imagetools create`.
- Anonymous HTTP manifest reads from both registries for `supabase/postgrest:v16.4`
  returned HTTP 200 and byte-identical JSON with the SHA-256 digest pinned above.
  The manifests contain these identical child digests:

  | Platform | Digest |
  | --- | --- |
  | Linux amd64 | `sha256:bee9e1efe9d90d8f6be359f756e039dbb6e1972474bc271b7c49c5a495911a41` |
  | Linux arm64 | `sha256:c3638ac25258ede665db66a4052b6fd30db4f22789327dce84599409136da35f` |

This establishes registry manifest equality and immutable image identity, not a
successful layer download or executed SQL proof. Run the harness and the complete
CI check to establish those separately. When changing the image version, recheck
the official package, registry manifest digests and actual test behavior.

The separate `scripts/check-supabase.mjs` vendor proof retains Supabase CLI
`2.120.0` and its actual safe-update assertions. That CLI's
[image resolution code](https://github.com/supabase/cli/blob/v2.120.0/apps/cli-go/internal/utils/docker.go)
already tries ECR, GHCR and Docker Hub in order when no registry override is set.
No CLI registry override or vendor image version changes are needed for this fix.
