import * as fs from 'fs';
import * as path from 'path';

/**
 * Logger utility
 */
export class Logger {
  private logPath: string | null = null;
  private stream: fs.WriteStream | null = null;

  constructor(logPath?: string) {
    if (logPath) {
      this.logPath = logPath;
      // Ensure directory exists
      const dir = path.dirname(logPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      this.stream = fs.createWriteStream(logPath, { flags: 'a' });
    }
  }

  write(message: string): void {
    const timestamp = new Date().toISOString();
    const line = `[${timestamp}] ${message}\n`;
    
    if (this.stream) {
      this.stream.write(line);
    } else {
      console.log(line.trim());
    }
  }

  close(): void {
    if (this.stream) {
      this.stream.end();
      this.stream = null;
    }
  }
}

