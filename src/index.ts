// src/index.ts
import path from 'path';
import {
  TpaServer,
  TpaSession,
  ViewType,
  TranslationData,
} from '@augmentos/sdk';
import { TranscriptProcessor, languageToLocale, convertLineWidth } from './utils';
import { convertToPinyin } from './utils/ChineseUtils';
import { ConfidenceCalculator, ConfidenceHeuristic } from './utils/confidenceHeuristics';
import axios from 'axios';
import fs from 'fs';

// Load TPA config to get default values
const tpaConfigPath = path.join(__dirname, './public/tpa_config.json');
const tpaConfig = JSON.parse(fs.readFileSync(tpaConfigPath, 'utf8'));

// Extract default values from config
const defaultSettings = {
  transcribeLanguage: tpaConfig.settings.find((s: any) => s.key === 'transcribe_language')?.defaultValue || 'Chinese (Hanzi)',
  translateLanguage: tpaConfig.settings.find((s: any) => s.key === 'translate_language')?.defaultValue || 'English',
  lineWidth: tpaConfig.settings.find((s: any) => s.key === 'line_width')?.defaultValue || 'Medium',
  numberOfLines: tpaConfig.settings.find((s: any) => s.key === 'number_of_lines')?.defaultValue || 3,
  displayMode: tpaConfig.settings.find((s: any) => s.key === 'display_mode')?.defaultValue || 'everything',
  confidenceHeuristic: tpaConfig.settings.find((s: any) => s.key === 'confidence_heuristic')?.defaultValue || 'None'
};

// Configuration constants
const PORT = process.env.PORT ? parseInt(process.env.PORT) : 80;
const PACKAGE_NAME = process.env.PACKAGE_NAME;
const AUGMENTOS_API_KEY = process.env.AUGMENTOS_API_KEY; // In production, this would be securely stored
const MAX_FINAL_TRANSCRIPTS = 100;

// Verify env vars are set
if (!AUGMENTOS_API_KEY) {
  throw new Error('AUGMENTOS_API_KEY environment variable is required.');
}
if (!PACKAGE_NAME) {
  throw new Error('PACKAGE_NAME environment variable is required.');
}

// User transcript processors map
const userTranscriptProcessors: Map<string, TranscriptProcessor> = new Map();
// Map to track the active languages for each user (source and target)
const userSourceLanguages: Map<string, string> = new Map();
const userTargetLanguages: Map<string, string> = new Map();
const userDisplayModes: Map<string, string> = new Map();
const userConfidenceCalculators: Map<string, ConfidenceCalculator> = new Map();
const userConfidenceHeuristics: Map<string, ConfidenceHeuristic> = new Map(); // Store per-user heuristic

// For debouncing transcripts per session
interface TranscriptDebouncer {
  lastSentTime: number;
  timer: NodeJS.Timeout | null;
}

/**
 * LiveTranslationApp - Main application class that extends TpaServer
 */
class LiveTranslationApp extends TpaServer {
  // Session debouncers for throttling non-final transcripts
  private sessionDebouncers = new Map<string, TranscriptDebouncer>();
  // Track active sessions by user ID
  private activeUserSessions = new Map<string, { session: TpaSession, sessionId: string }>();

  constructor() {
    super({
      packageName: PACKAGE_NAME!,
      apiKey: AUGMENTOS_API_KEY!,
      port: PORT,
      publicDir: path.join(__dirname, './public'),
    });
  }

  /**
   * Called by TpaServer when a new session is created
   */
  protected async onSession(session: TpaSession, sessionId: string, userId: string): Promise<void> {
    console.log(`\n\n🗣️🗣️🗣️Received new session for user ${userId}, session ${sessionId}\n\n`);

    // Initialize transcript processor and debouncer for this session
    this.sessionDebouncers.set(sessionId, { lastSentTime: 0, timer: null });
    
    // Store the active session for this user
    this.activeUserSessions.set(userId, { session, sessionId });

    try {
      // Set up settings change handlers
      this.setupSettingsHandlers(session, sessionId, userId);
      
      // Apply initial settings
      await this.applySettings(session, sessionId, userId);

    } catch (error) {
      console.error('Error initializing session:', error);
      // Apply default settings if there was an error
      const transcriptProcessor = new TranscriptProcessor(
        convertLineWidth(defaultSettings.lineWidth, defaultSettings.translateLanguage.toLowerCase().includes('hanzi')), 
        defaultSettings.numberOfLines, 
        MAX_FINAL_TRANSCRIPTS
      );
      userTranscriptProcessors.set(userId, transcriptProcessor);
      
      // Default source and target languages from config
      const sourceLang = defaultSettings.transcribeLanguage;
      const targetLang = defaultSettings.translateLanguage;
      const sourceLocale = languageToLocale(sourceLang);
      const targetLocale = languageToLocale(targetLang);

      console.log(`[Session ${sessionId}]: sourceLang=${sourceLang}, targetLang=${targetLang}`);
      userSourceLanguages.set(userId, sourceLang);
      userTargetLanguages.set(userId, targetLang);
      userDisplayModes.set(userId, defaultSettings.displayMode);
      userConfidenceCalculators.set(userId, new ConfidenceCalculator());
      userConfidenceHeuristics.set(userId, defaultSettings.confidenceHeuristic as ConfidenceHeuristic);

      // Setup handler for translation data
      const cleanup = session.onTranslationForLanguage(sourceLocale, targetLocale, (data: TranslationData) => {
        this.handleTranslation(session, sessionId, userId, data);
      });
      
      // Register cleanup handler
      this.addCleanupHandler(cleanup);
    }
  }

  /**
   * Set up handlers for settings changes
   */
  private setupSettingsHandlers(
    session: TpaSession,
    sessionId: string,
    userId: string
  ): void {
    // Handle line width changes
    session.settings.onValueChange('line_width', (newValue, oldValue) => {
      console.log(`Line width changed for user ${userId}: ${oldValue} -> ${newValue}`);
      this.applySettings(session, sessionId, userId);
    });

    // Handle number of lines changes
    session.settings.onValueChange('number_of_lines', (newValue, oldValue) => {
      console.log(`Number of lines changed for user ${userId}: ${oldValue} -> ${newValue}`);
      this.applySettings(session, sessionId, userId);
    });

    // Handle source language changes
    session.settings.onValueChange('transcribe_language', (newValue, oldValue) => {
      console.log(`Transcribe language changed for user ${userId}: ${oldValue} -> ${newValue}`);
      this.applySettings(session, sessionId, userId);
    });

    // Handle target language changes
    session.settings.onValueChange('translate_language', (newValue, oldValue) => {
      console.log(`Translate language changed for user ${userId}: ${oldValue} -> ${newValue}`);
      this.applySettings(session, sessionId, userId);
    });

    // Handle display mode changes
    session.settings.onValueChange('display_mode', (newValue, oldValue) => {
      console.log(`Display mode changed for user ${userId}: ${oldValue} -> ${newValue}`);
      this.applySettings(session, sessionId, userId);
    });

    // Handle confidence heuristic changes
    session.settings.onValueChange('confidence_heuristic', (newValue, oldValue) => {
      console.log(`Confidence heuristic changed for user ${userId}: ${oldValue} -> ${newValue}`);
      this.applySettings(session, sessionId, userId);
    });
  }

  /**
   * Apply settings from the session to the transcript processor
   */
  private async applySettings(
    session: TpaSession,
    sessionId: string,
    userId: string
  ): Promise<void> {
    try {
      // Extract settings
      const sourceLang = session.settings.get<string>('transcribe_language', defaultSettings.transcribeLanguage);
      const targetLang = session.settings.get<string>('translate_language', defaultSettings.translateLanguage);
      const displayMode = session.settings.get<string>('display_mode', defaultSettings.displayMode);
      const lineWidthSetting = session.settings.get<string>('line_width', defaultSettings.lineWidth);
      const numberOfLinesSetting = session.settings.get<number>('number_of_lines', defaultSettings.numberOfLines);
      // const confidenceHeuristicSetting = session.settings.get<string>('confidence_heuristic', defaultSettings.confidenceHeuristic) as ConfidenceHeuristic;
      const confidenceHeuristicSetting: ConfidenceHeuristic = 'None';

      // Get previous values for comparison
      const previousSourceLang = userSourceLanguages.get(userId);
      const previousTargetLang = userTargetLanguages.get(userId);
      const languageChanged = (previousSourceLang && previousSourceLang !== sourceLang) || 
                              (previousTargetLang && previousTargetLang !== targetLang);
      
      // Update stored settings
      userSourceLanguages.set(userId, sourceLang);
      userTargetLanguages.set(userId, targetLang);
      userDisplayModes.set(userId, displayMode);
      userConfidenceHeuristics.set(userId, confidenceHeuristicSetting);
      
      // Update or initialize confidence calculator
      let confidenceCalculator = userConfidenceCalculators.get(userId);
      if (!confidenceCalculator) {
        confidenceCalculator = new ConfidenceCalculator();
        userConfidenceCalculators.set(userId, confidenceCalculator);
      }
      // confidenceCalculator.setHeuristic(confidenceHeuristicSetting);

      console.log(`[Session ${sessionId}]: sourceLang=${sourceLang}, targetLang=${targetLang}`);

      // Convert locales
      const sourceLocale = languageToLocale(sourceLang);
      const targetLocale = languageToLocale(targetLang);

      console.log(`[Session ${sessionId}]: sourceLocale=${sourceLocale}, targetLocale=${targetLocale}`);
      
      // Process line width and other formatting settings
      const isChineseTarget = targetLang.toLowerCase().includes('hanzi') || targetLocale.toLowerCase().startsWith('ja-');
      const lineWidth = convertLineWidth(lineWidthSetting, isChineseTarget);
      
      let numberOfLines = typeof numberOfLinesSetting === 'number' ? numberOfLinesSetting : parseInt(numberOfLinesSetting);
      if (isNaN(numberOfLines) || numberOfLines < 1) numberOfLines = defaultSettings.numberOfLines;

      console.log(`Applied settings for user ${userId}: sourceLang=${sourceLang}, targetLang=${targetLang}, displayMode=${displayMode}, lineWidth=${lineWidth}, numberOfLines=${numberOfLines}, confidenceHeuristic=${confidenceHeuristicSetting}`);
      
      // Get previous processor to check for language changes and preserve history
      const previousTranscriptProcessor = userTranscriptProcessors.get(userId);
      
      // Create new processor with the settings
      const newProcessor = new TranscriptProcessor(lineWidth, numberOfLines, MAX_FINAL_TRANSCRIPTS, isChineseTarget);

      // Preserve transcript history if language didn't change and we have a previous processor
      if (!languageChanged && previousTranscriptProcessor) {
        const previousHistory = previousTranscriptProcessor.getFinalTranscriptHistory();
        for (const transcript of previousHistory) {
          newProcessor.processString(transcript, true);
        }
        console.log(`Preserved ${previousHistory.length} transcripts after settings change`);
      } else if (languageChanged) {
        console.log(`Cleared transcript history due to language change`);
        confidenceCalculator.resetState();
      }

      // Update the processor
      userTranscriptProcessors.set(userId, newProcessor);

      // Show the updated transcript layout immediately with the new formatting
      const formattedTranscript = newProcessor.processString("", true);
      this.showTranscriptsToUser(session, formattedTranscript, true);

      // Setup handler for translation data
      console.log(`Setting up translation handlers for session ${sessionId} (${sourceLocale}->${targetLocale})`);
      
      // Create handler for the language pair
      const translationHandler = (data: TranslationData) => {
        this.handleTranslation(session, sessionId, userId, data);
      };

      // Subscribe to language-specific translation
      const cleanup = session.onTranslationForLanguage(sourceLocale, targetLocale, translationHandler);
      
      // Register cleanup handler
      this.addCleanupHandler(cleanup);
      
      console.log(`Subscribed to translations from ${sourceLocale} to ${targetLocale} for user ${userId}`);
      
    } catch (error) {
      console.error(`Error applying settings for user ${userId}:`, error);
      throw error;
    }
  }

  /**
   * Called by TpaServer when a session is stopped
   */
  protected async onStop(sessionId: string, userId: string, reason: string): Promise<void> {
    console.log(`Session ${sessionId} stopped: ${reason}`);
    
    // Clean up session resources
    const debouncer = this.sessionDebouncers.get(sessionId);
    if (debouncer?.timer) {
      clearTimeout(debouncer.timer);
    }
    this.sessionDebouncers.delete(sessionId);
    
    // Remove active session if it matches this session ID
    const activeSession = this.activeUserSessions.get(userId);
    if (activeSession && activeSession.sessionId === sessionId) {
      this.activeUserSessions.delete(userId);
    }
  }

  /**
   * Handles translation data from the AugmentOS cloud
   */
  private handleTranslation(
    session: TpaSession, 
    sessionId: string, 
    userId: string, 
    translationData: TranslationData
  ): void {
    console.log(`[Session ${sessionId}]: Handling translation for user ${userId}`);

    let transcriptProcessor = userTranscriptProcessors.get(userId);
    if (!transcriptProcessor) {
      const targetLang = userTargetLanguages.get(userId) || defaultSettings.translateLanguage;
      const isChineseTarget = targetLang.toLowerCase().startsWith('zh-') || targetLang.toLowerCase().startsWith('ja-');
      transcriptProcessor = new TranscriptProcessor(
        convertLineWidth(defaultSettings.lineWidth, isChineseTarget),
        defaultSettings.numberOfLines,
        MAX_FINAL_TRANSCRIPTS,
        isChineseTarget
      );
      userTranscriptProcessors.set(userId, transcriptProcessor);
    }

    console.log(`[Session ${sessionId}]: Confidence calculator: ${userConfidenceCalculators.get(userId)}`);

    let confidenceCalculator = userConfidenceCalculators.get(userId);
    if (!confidenceCalculator) {
      confidenceCalculator = new ConfidenceCalculator();
      userConfidenceCalculators.set(userId, confidenceCalculator);
    }

    // Use the cached heuristic for this user
    const confidenceHeuristicSetting = userConfidenceHeuristics.get(userId) || defaultSettings.confidenceHeuristic;
    console.log(`[Session ${sessionId}]: Confidence heuristic: ${confidenceHeuristicSetting}`);

    // Check if we should accept this interim transcript (length protection)
    // if (!confidenceCalculator.shouldAcceptInterim(translationData.text, translationData.isFinal)) {
    if (false) {
      console.log(`[Session ${sessionId}]: Rejecting shorter interim transcript`);
      return; // Don't process shorter interim transcripts
    }

    const isFinal = translationData.isFinal;
    let newText = translationData.text;
    const sourceLanguage = userSourceLanguages.get(userId) || defaultSettings.transcribeLanguage;
    const targetLanguage = userTargetLanguages.get(userId) || defaultSettings.translateLanguage;
    const sourceLocale = languageToLocale(sourceLanguage);
    const targetLocale = languageToLocale(targetLanguage);

    // Get the display mode from settings or use default
    const displayMode = userDisplayModes.get(userId) || defaultSettings.displayMode;
    
    // If display mode is set to translations and the text is not in source language, return early
    if (displayMode === 'translations' && !translationData.didTranslate) {
      console.log(`[Session ${sessionId}]: Skipping translation - not in source language (${sourceLocale})`);
      return;
    }

    // console.log(`[Session ${sessionId}]: Received translation (${sourceLocale}->${targetLocale})`);

    if (targetLanguage === 'Chinese (Pinyin)') {
      const pinyinTranscript = convertToPinyin(newText);
      console.log(`[Session ${sessionId}]: Converting Chinese to Pinyin`);
      newText = pinyinTranscript;
    }

    let textToDisplay;
    if (isFinal) {
      // For final translations, show the full transcript
      textToDisplay = transcriptProcessor.processString(newText, isFinal);
      confidenceCalculator.resetState(); // Reset confidence state on final transcript
      confidenceCalculator.resetInterimTracking(); // Reset interim tracking after final transcript
      console.log(`[Session ${sessionId}]: finalTranscriptCount=${transcriptProcessor.getFinalTranscriptHistory().length}`);
    } else {
      // For interim, show only the confident prefix (plus transcript history) if heuristic is not 'None'
      const isHanzi = targetLanguage.toLowerCase().includes('hanzi') || targetLocale.toLowerCase().startsWith('ja-');
      let confidentPrefix: string;
      if (confidenceHeuristicSetting === 'None') {
        confidentPrefix = newText;
      } else {
        // Update the confidence calculator's state for this interim
        confidenceCalculator.calculateConfidence(newText, isHanzi, confidenceHeuristicSetting as ConfidenceHeuristic);
        confidentPrefix = confidenceCalculator.getNonShrinkingConfidentPrefix(newText, 0.4, isHanzi, confidenceHeuristicSetting as ConfidenceHeuristic);
      }
      // Only pass the confident prefix to the processor (it manages its own history)
      textToDisplay = transcriptProcessor.processString(confidentPrefix, false);
    }

    console.log(`[Session ${sessionId}]: ${textToDisplay}`);
    console.log(`[Session ${sessionId}]: isFinal=${isFinal}`);

    this.debounceAndShowTranscript(session, sessionId, textToDisplay, isFinal);
  }

  /**
   * Debounces transcript display to avoid too frequent updates for non-final transcripts
   */
  private debounceAndShowTranscript(
    session: TpaSession,
    sessionId: string,
    transcript: string,
    isFinal: boolean
  ): void {
    const debounceDelay = 400; // in milliseconds
    let debouncer = this.sessionDebouncers.get(sessionId);
    
    if (!debouncer) {
      debouncer = { lastSentTime: 0, timer: null };
      this.sessionDebouncers.set(sessionId, debouncer);
    }

    // Clear any scheduled timer
    if (debouncer.timer) {
      clearTimeout(debouncer.timer);
      debouncer.timer = null;
    }

    const now = Date.now();

    // Show final transcripts immediately
    if (isFinal) {
      this.showTranscriptsToUser(session, transcript, isFinal);
      debouncer.lastSentTime = now;
      return;
    }

    // Throttle non-final transcripts
    if (now - debouncer.lastSentTime >= debounceDelay) {
      this.showTranscriptsToUser(session, transcript, false);
      debouncer.lastSentTime = now;
    } else {
      debouncer.timer = setTimeout(() => {
        this.showTranscriptsToUser(session, transcript, false);
        if (debouncer) {
          debouncer.lastSentTime = Date.now();
        }
      }, debounceDelay);
    }
  }

  /**
   * Cleans the transcript text by removing leading punctuation while preserving Spanish question marks
   * and Chinese characters
   */
  private cleanTranscriptText(text: string): string {
    // Remove basic punctuation marks (both Western and Chinese)
    // Western: . , ; : ! ?
    // Chinese: 。 ， ； ： ！ ？
    return text.replace(/^[.,;:!?。，；：！？]+/, '').trim();
  }

  /**
   * Displays transcript text in the AR view
   */
  private showTranscriptsToUser(
    session: TpaSession,
    transcript: string,
    isFinal: boolean
  ): void {
    const cleanedTranscript = this.cleanTranscriptText(transcript);

    session.layouts.showTextWall(cleanedTranscript, {
      view: ViewType.MAIN,
      // Use a fixed duration for final transcripts (20 seconds)
      durationMs: isFinal ? 20000 : undefined,
    });
  }

  /**
   * Helper method to get active session for a user
   */
  public getActiveSessionForUser(userId: string): { session: TpaSession, sessionId: string } | null {
    return this.activeUserSessions.get(userId) || null;
  }
}

// Create and start the app
const liveTranslationApp = new LiveTranslationApp();

// Add health check endpoint
const expressApp = liveTranslationApp.getExpressApp();
expressApp.get('/health', (req: any, res: any) => {
  res.json({ status: 'healthy', app: PACKAGE_NAME });
});

// Start the server
liveTranslationApp.start().then(() => {
  console.log(`${PACKAGE_NAME} server running on port ${PORT}`);
}).catch(error => {
  console.error('Failed to start server:', error);
});