/** Centralized data-testid selectors for E2E tests */

export const sel = {
  // TabBar
  tabBar: '[data-testid="tab-bar"]',
  tab: (id: string) => `[data-testid="tab-${id}"]`,
  tabCreate: '[data-testid="tab-create"]',
  tabSettings: '[data-testid="tab-settings"]',
  tabClose: (id: string) => `[data-testid="tab-close-${id}"]`,

  // SmartInput
  smartInput: '[data-testid="smart-input"]',
  smartInputTextarea: '[data-testid="smart-input-textarea"]',
  modeButton: '[data-testid="mode-button"]',
  modeMenu: '[data-testid="mode-menu"]',
  modeOption: (mode: string) => `[data-testid="mode-option-${mode}"]`,
  sendButton: '[data-testid="send-button"]',
  stopButton: '[data-testid="stop-button"]',
  imageUploadButton: '[data-testid="image-upload-button"]',

  // ContextBar
  contextBar: '[data-testid="context-bar"]',
  cwdDisplay: '[data-testid="cwd-display"]',
  modelSelector: '[data-testid="model-selector"]',
  modelMenu: '[data-testid="model-menu"]',
  modelOption: (name: string) => `[data-testid="model-option-${name}"]`,
  contextRing: '[data-testid="context-ring"]',
  contextModal: '[data-testid="context-modal"]',

  // SettingsPane
  settingsNav: (id: string) => `[data-testid="settings-nav-${id}"]`,
  providerSelect: '[data-testid="provider-select"]',
  modelItem: (name: string) => `[data-testid="model-item-${name}"]`,
  customModelInput: '[data-testid="custom-model-input"]',
  apiKeyInput: '[data-testid="api-key-input"]',
  baseUrlInput: '[data-testid="base-url-input"]',
  baseUrlConfirm: '[data-testid="base-url-confirm"]',
  testConnectionButton: '[data-testid="test-connection-button"]',
  testStatus: '[data-testid="test-status"]',
  themeButton: (id: string) => `[data-testid="theme-${id}"]`,
  viewModeButton: (id: string) => `[data-testid="view-mode-${id}"]`,
  hotkeyButton: (action: string) => `[data-testid="hotkey-${action}"]`,
  clearProviderButton: '[data-testid="clear-provider-button"]',
  contextWindowSlider: '[data-testid="context-window-slider"]',
  maxStepsSlider: '[data-testid="max-steps-slider"]',

  // AgentOverlay
  agentOverlay: '[data-testid="agent-overlay"]',
  agentStep: (i: number) => `[data-testid="agent-step-${i}"]`,
  agentStatus: '[data-testid="agent-status"]',
  agentClear: '[data-testid="agent-clear"]',
  agentMinimize: '[data-testid="agent-minimize"]',
  permissionModal: '[data-testid="permission-modal"]',
  permissionAllow: '[data-testid="permission-allow"]',
  permissionDeny: '[data-testid="permission-deny"]',
  thinkingToggle: '[data-testid="thinking-toggle"]',
  autoexecToggle: '[data-testid="autoexec-toggle"]',

  // OnboardingWizard
  onboardingWizard: '[data-testid="onboarding-wizard"]',
  onboardingNext: '[data-testid="onboarding-next"]',
  onboardingPrev: '[data-testid="onboarding-prev"]',
  onboardingTheme: (id: string) => `[data-testid="onboarding-theme-${id}"]`,
  onboardingView: (id: string) => `[data-testid="onboarding-view-${id}"]`,
  onboardingProviderSelect: '[data-testid="onboarding-provider-select"]',

  // Close Confirm Modal
  closeConfirmModal: '[data-testid="close-confirm-modal"]',
  closeConfirmSave: '[data-testid="close-confirm-save"]',
  closeConfirmDiscard: '[data-testid="close-confirm-discard"]',
  closeConfirmCancel: '[data-testid="close-confirm-cancel"]',
};
