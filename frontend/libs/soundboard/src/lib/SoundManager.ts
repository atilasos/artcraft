import { GetAppPreferences } from "@storyteller/tauri-api";
import { SoundEffect } from "./SoundEffect";
import { SoundRegistry } from "./SoundRegistry";

type SoundDef = {
  key: string;
  path: string;
  volume: number;
  // Present iff the sound is user-selectable in Settings → Alerts.
  // Sounds without a label are still registered and can be played by key.
  label?: string;
};

// NRS build: the bundled sound effects were from Nintendo games with no licence
// (see NOTICE), so the files and this catalogue were removed. Every sound
// setting falls back to silence; add licence-clean files here to restore it.
const SOUNDS: readonly SoundDef[] = [];

export type SoundOption = { value: string; label: string };

type SoundPrefKey =
  | "delete_file_sound"
  | "enqueue_success_sound"
  | "enqueue_failure_sound"
  | "generation_success_sound"
  | "generation_failure_sound";

export class SoundManager {
  // Dropdown options for AudioSettingsPane.
  // "None (Silent)" first, then user-selectable sounds A→Z by label.
  static readonly OPTIONS: SoundOption[] = [
    { value: "none", label: "None (Silent)" },
    ...SOUNDS
      .filter((s): s is SoundDef & { label: string } => !!s.label)
      .map((s) => ({ value: s.key, label: s.label }))
      .sort((a, b) => a.label.localeCompare(b.label)),
  ];

  private static installed = false;

  // Register the sound catalog. Idempotent — safe to call twice.
  static install() {
    if (this.installed) return;
    const r = SoundRegistry.getInstance();
    for (const s of SOUNDS) {
      r.setSoundOnce(s.key, new SoundEffect(s.path, { defaultVolume: s.volume }));
    }
    this.installed = true;
  }

  // Settings preview — fires regardless of the master toggle.
  static playPreview(soundName: string) {
    if (!soundName || soundName === "none") return;
    SoundRegistry.getInstance().playSound(soundName);
  }

  // Event-driven playback — gated on `play_sounds`.
  static async playFileDeleted()       { await this.playEvent("delete_file_sound"); }
  static async playEnqueueSuccess()    { await this.playEvent("enqueue_success_sound"); }
  static async playEnqueueFailure()    { await this.playEvent("enqueue_failure_sound"); }
  static async playGenerationSuccess() { await this.playEvent("generation_success_sound"); }
  static async playGenerationFailure() { await this.playEvent("generation_failure_sound"); }

  private static async playEvent(prefKey: SoundPrefKey) {
    const prefs = (await GetAppPreferences()).preferences;
    if (!prefs?.play_sounds) return;
    const soundName = prefs[prefKey];
    if (!soundName) return;
    SoundRegistry.getInstance().playSound(soundName);
  }
}
