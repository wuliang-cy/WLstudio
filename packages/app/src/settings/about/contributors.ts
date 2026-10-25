const CREDITED_CONTRIBUTORS = 16

/**
 * The upstream project this application derives from credited 16 people by name. The About page
 * shows the wider contributor count as a plain number, so it no longer reaches out to the upstream
 * repository: the figure is a fixed constant and costs no network request.
 */
export const FALLBACK_OTHER_CONTRIBUTORS = 935

export function otherContributorCount(link: string | null) {
  const total = Number.parseInt(link?.match(/[?&]page=(\d+)[^>]*>;\s*rel="last"/)?.[1] ?? "", 10)

  if (!Number.isFinite(total) || total <= CREDITED_CONTRIBUTORS) return FALLBACK_OTHER_CONTRIBUTORS

  return total - CREDITED_CONTRIBUTORS
}

export function loadOtherContributorCount(_fetcher: typeof fetch) {
  return Promise.resolve(FALLBACK_OTHER_CONTRIBUTORS)
}
