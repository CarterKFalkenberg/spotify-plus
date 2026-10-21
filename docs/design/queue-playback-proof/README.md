# Queue listening: visual proof

These screenshots use fictional songs, drawn fixture artwork, a synthetic library API and a simulated Spotify SDK. They prove the rendered flow and controlled state transitions; they do not establish real audio, browser DRM support, Spotify permissions, or human phone/tagging-speed acceptance. All unrecognized nonlocal requests were blocked.

Before: `954b15ecfd877782c05af7f0f368ac34c2c248bf`. After: `962df1ea3ceb6349ce93ce8e57f9c716c4f43446`; the reviewed proof commit preserves the identical app Git tree. The [manifest](manifest.json) records source identities, viewport sizes and screenshot SHA-256 digests.

The new control starts at one-third into the song. The flow below shows explicit Play, confirmed sampling with Pause, automatic pause after 20 seconds, and Play more continuing until paused. Source tests additionally cover lifecycle cancellation, delayed/ambiguous responses, missing permission, bounded pause confirmation and disconnect.

## Desktop · light

Matched viewport: 1440 × 1000. Before offers Open in Spotify; after adds optional listening while preserving tags and navigation.

| Before | After the 20-second sample |
| --- | --- |
| ![Before desktop light](before-desktop-light.png) | ![After desktop light, automatically paused](after-desktop-light-paused.png) |

### Play → sample → Play more

![Ready to play, desktop light](after-desktop-light-idle.png)

![Confirmed sample playing with Pause, desktop light](after-desktop-light-playing.png)

![Play more continues until paused, desktop light](after-desktop-light-more.png)

## Desktop · dark

Matched viewport: 1440 × 1000. Before offers Open in Spotify; after adds optional listening while preserving tags and navigation.

| Before | After the 20-second sample |
| --- | --- |
| ![Before desktop dark](before-desktop-dark.png) | ![After desktop dark, automatically paused](after-desktop-dark-paused.png) |

### Play → sample → Play more

![Ready to play, desktop dark](after-desktop-dark-idle.png)

![Confirmed sample playing with Pause, desktop dark](after-desktop-dark-playing.png)

![Play more continues until paused, desktop dark](after-desktop-dark-more.png)

## Phone · light

Matched viewport: 390 × 844. Before offers Open in Spotify; after adds optional listening while preserving tags and navigation.

| Before | After the 20-second sample |
| --- | --- |
| ![Before phone light](before-phone-light.png) | ![After phone light, automatically paused](after-phone-light-paused.png) |

### Play → sample → Play more

![Ready to play, phone light](after-phone-light-idle.png)

![Confirmed sample playing with Pause, phone light](after-phone-light-playing.png)

![Play more continues until paused, phone light](after-phone-light-more.png)

## Phone · dark

Matched viewport: 390 × 844. Before offers Open in Spotify; after adds optional listening while preserving tags and navigation.

| Before | After the 20-second sample |
| --- | --- |
| ![Before phone dark](before-phone-dark.png) | ![After phone dark, automatically paused](after-phone-dark-paused.png) |

### Play → sample → Play more

![Ready to play, phone dark](after-phone-dark-idle.png)

![Confirmed sample playing with Pause, phone dark](after-phone-dark-playing.png)

![Play more continues until paused, phone dark](after-phone-dark-more.png)
