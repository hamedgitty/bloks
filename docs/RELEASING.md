# Releasing

A release is a signed, notarized macOS build plus unsigned Windows and
Linux builds, all attached to one GitHub Release. Pushing a tag does
the work; a human writes the notes and clicks publish.

Two workflows run on the tag and attach to the same draft:
[`release.yml`](../.github/workflows/release.yml) signs and notarizes
the macOS build, and
[`desktop-builds.yml`](../.github/workflows/desktop-builds.yml) produces
the Windows and Linux ones. Nothing here needs to run on your machine.

## Why signing and notarization matter

An unsigned `.dmg` gets a Gatekeeper dialog saying the app "cannot be
opened because the developer cannot be verified", and the only way past
it is a right-click and a second confirmation. For an app whose whole
pitch is that it runs locally with access to your files, asking people to
override a macOS security warning on first launch is the wrong first
impression. Signing and notarization remove the dialog entirely.

Notarization also means Apple has scanned the binary. That is not a
security guarantee for anyone, but it does mean a compromised build is
revocable.

## One-time setup

You need an Apple Developer Program membership (99 USD a year). There is
no free path: notarization requires a Developer ID certificate, and those
only come with a paid membership.

### 1. Developer ID Application certificate

Joining the Developer Program does not give you a certificate. You create
one, and it lands in your login keychain. Until then this prints
`0 valid identities found`, which is the expected starting state and not
a sign anything is wrong:

```sh
security find-identity -v -p codesigning
```

It has to be a **Developer ID Application** certificate. *Apple
Development* and *Mac App Store* cannot be notarized for distribution
outside the App Store, and Apple's UI offers all three next to each
other.

**With full Xcode:** Settings → Accounts → your Apple ID → **Manage
Certificates → + → Developer ID Application**.

**With only the command line tools**, which is the common case, there is
no Manage Certificates window. Make the request yourself:

1. Keychain Access → menu **Certificate Assistant → Request a Certificate
   From a Certificate Authority**.
2. Fill in your email and name, choose **Saved to disk**, and tick **Let
   me specify key pair information**. Take the defaults on the next
   screen (2048 bits, RSA). Save the `.certSigningRequest`.
3. At [developer.apple.com/account/resources/certificates](https://developer.apple.com/account/resources/certificates),
   press **+**, pick **Developer ID Application**, upload the request,
   and download the `.cer`.
4. Double-click the `.cer` to install it.

Either way, `security find-identity -v -p codesigning` should now list
one identity, and the ten characters in parentheses at the end of it are
your team ID.

Then in Keychain Access, select the **login** keychain and the **My
Certificates** category, find the certificate, right-click, **Export**,
and choose **Personal Information Exchange (.p12)**. Exporting the
certificate rather than the key underneath it is what bundles the two
together, which is what signing needs.

Two password prompts follow and they are not the same thing. The first
sets a password on the `.p12` file: invent one, and that is
`CSC_KEY_PASSWORD`. The second asks for your macOS login password, to
authorise reading a private key out of the keychain at all.

Turn the `.p12` into something a secret can hold. Keychain Access
usually saves to the Desktop, so find it first:

```sh
ls -l ~/Desktop/*.p12 ~/Downloads/*.p12 2>/dev/null
base64 -i ~/Desktop/Certificates.p12 | pbcopy
```

That prints nothing on purpose. `pbcopy` puts the encoded key straight on
the clipboard, ready to paste into the secret, without it passing through
terminal scrollback. To check it worked before pasting:

```sh
pbpaste | wc -c      # a few thousand characters
pbpaste | head -c 3  # MII, how every base64 PKCS#12 file starts
```

**Keep that `.p12` somewhere you will still have it in five years**, a
password manager rather than a Downloads folder. The private key is
generated on one machine and never leaves it, so Apple cannot reissue it:
a lost key means revoking the certificate and starting again, against a
capped number of Developer ID certificates per account. This is also why
Xcode will happily show you certificates marked "Not in Keychain", which
means they were made on a different Mac and this one does not hold the
key.

Two things that block the certificate rather than break it. A membership
paid for in the last day or two may not be active yet, and Developer ID
creation stays greyed out until it is. And on an Organization account,
only the Account Holder can create Developer ID certificates, by design.

### 2. App-specific password

At [appleid.apple.com](https://appleid.apple.com), **Sign-In and
Security → App-Specific Passwords → Generate**. Name it something you
will recognise in a year, like "bloks notarization". Copy it once; Apple
will not show it again.

Your normal Apple ID password does not work here, and neither does a
password from an account without the Developer Program.

### 3. Team ID

Ten characters. Easiest read off the certificate you just made, in the
parentheses at the end of the line:

```sh
security find-identity -v -p codesigning
```

It is also at
[developer.apple.com/account](https://developer.apple.com/account) under
Membership Details.

### 4. Put them in the repository

**Settings → Secrets and variables → Actions → New repository secret**,
five of them:

| Secret | What it is |
| --- | --- |
| `CSC_LINK` | The base64 of the `.p12` from step 1 |
| `CSC_KEY_PASSWORD` | The password you set when exporting it |
| `APPLE_ID` | The Apple ID email on the developer account |
| `APPLE_APP_SPECIFIC_PASSWORD` | The password from step 2 |
| `APPLE_TEAM_ID` | The ten characters from step 3 |

The workflow checks all five before it builds anything, so a missing one
fails in about a minute instead of twenty. That check exists because
electron-builder does not fail on missing notarization credentials: it
logs "skipped macOS notarization" and carries on, and a signed but
un-notarized `.dmg` looks completely normal until someone downloads it.
The `xcrun stapler validate` step at the end of the workflow is the
second line of defence against the same mistake.

Certificates expire after five years and app-specific passwords stop
working if you change your Apple ID password. Both fail loudly.

## Cutting a release

```sh
# 1. Bump the version. Artifact filenames come from here.
#    Edit package.json, then:
git commit -am "0.2.0"

# 2. Tag it. The workflow refuses to build if the tag and the
#    package.json version disagree.
git tag v0.2.0
git push -u origin main
git push origin v0.2.0
```

The workflow then typechecks, runs the suite, builds a universal app,
signs it, sends it to Apple, staples the ticket, and uploads a **draft**
release. Notarization is a network round trip and usually takes a few
minutes, so budget fifteen to twenty for the whole run.

When it finishes, go to **Releases**, find the draft, write the notes,
and publish. Until you do, nothing is public.

Before publishing, download the `.dmg` from the draft on a Mac that has
never built this app and open it. That catches the failure mode automated
checks cannot: a build that is signed and notarized and still broken.

## Trying it without releasing anything

**Actions → Release → Run workflow**, leave "dry run" ticked. It builds
and signs and notarizes exactly as a real release would, then uploads the
`.dmg` and `.zip` as workflow artifacts instead of creating a release.
Use it after changing anything about signing, or the first time you set
the secrets up.

## Building locally

```sh
pnpm package
```

On a machine with no Developer ID certificate you get an unsigned build
in `release/`, and macOS warns on it, which is correct.

Once you have done the one-time setup above, that is no longer what
happens. electron-builder discovers the identity sitting in your login
keychain and signs with it, then tries to notarize, which fails unless
the three Apple variables are exported too. For a deliberately unsigned
build, turn the discovery off:

```sh
CSC_IDENTITY_AUTO_DISCOVERY=false pnpm package
```

Signing locally on purpose is rarely worth it. The runner is a clean
machine, which is the point.

## When notarization fails

Apple's rejections arrive as a log URL in the build output. Fetch it:

```sh
xcrun notarytool log <submission-id> \
  --apple-id "$APPLE_ID" \
  --team-id "$APPLE_TEAM_ID" \
  --password "$APPLE_APP_SPECIFIC_PASSWORD"
```

The three that actually happen:

- **"The signature does not include a secure timestamp."** Something was
  signed offline. Re-run; it is almost always transient.
- **"The executable does not have the hardened runtime enabled."** A
  binary got into the bundle without going through electron-builder.
  Anything shipped in `extraResources` has to be signable, which is why
  the Swift helpers are built rather than downloaded.
- **"Team is not yet configured for notarization."** A brand new
  developer account. It clears on Apple's side within a day.

An unhelpful one worth naming: if the build succeeds but the app is
"damaged" on another machine, the ticket did not staple. The workflow
runs `xcrun stapler validate` for exactly that reason, so check whether
that step passed.

## Auto-update

`electron-updater` is wired in and runs in packaged builds only, on
every platform. It checks GitHub on launch, downloads in the background
and installs on quit.

It needs more than the installers. Each platform's build also writes an
update manifest (`latest-mac.yml`, `latest.yml`, `latest-linux.yml`) and
a `.blockmap` per artifact, and every one of those is attached alongside
the binaries. Without the manifest a packaged build checks for updates
forever and never finds one, silently, because a missing manifest is a
404 the updater swallows. Without the blockmaps an update is a whole
redownload rather than a delta. If you touch the upload globs in either
workflow, keep them.

## What is not automated

- Release notes. Write them yourself. A changelog generated from commit
  subjects is worse than three sentences about what changed.
- Publishing. Every tag produces a draft, never a published release.
- Windows and Linux signing. Those builds are attached automatically but
  unsigned, so SmartScreen warns on first run; Linux does not expect a
  signature at all. A Windows certificate is a purchase rather than a
  build step, and drops in through `CSC_LINK` the same way the macOS
  identity does.
