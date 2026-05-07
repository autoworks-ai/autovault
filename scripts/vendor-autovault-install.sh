#!/bin/sh

# Drop-in helper for third-party skill installers.
# Usage from a vendor script:
#
#   . ./vendor-autovault-install.sh
#   install_native() { ...; }
#   autovault_install_skill_bundle "$source_dir" "$REPO" install_native

autovault_install_skill_bundle() {
  av_source_dir="${1:?missing local skill directory}"
  av_source_id="${2:?missing source identifier}"
  av_native_fn="${3:-install_native}"
  av_mode="${AUTOVAULT_SKILL_INSTALL:-prefer-autovault}"

  av_run_autovault() {
    command -v autovault >/dev/null 2>&1 || return 127
    autovault add-local "$av_source_dir" --source "$av_source_id" --sync-profiles
  }

  av_run_native() {
    command -v "$av_native_fn" >/dev/null 2>&1 || return 127
    "$av_native_fn"
  }

  case "$av_mode" in
    ""|prefer|prefer-autovault)
      av_run_autovault && return 0
      av_run_native
      ;;
    both)
      av_run_autovault
      av_autovault_status=$?
      av_run_native
      av_native_status=$?
      if [ "$av_autovault_status" -eq 127 ]; then
        [ "$av_native_status" -eq 0 ]
      else
        [ "$av_autovault_status" -eq 0 ] && [ "$av_native_status" -eq 0 ]
      fi
      ;;
    native)
      av_run_native && return 0
      av_run_autovault
      ;;
    native-only)
      av_run_native
      ;;
    off)
      return 0
      ;;
    *)
      printf 'Invalid AUTOVAULT_SKILL_INSTALL mode: %s\n' "$av_mode" >&2
      return 2
      ;;
  esac
}
