import * as fs from 'fs';
import * as path from 'path';

/**
 * Simple file logger that writes directly without timestamps
 * Used for job logs to match the original behavior
 */
export class FileLogger {
  private stream: fs.WriteStream;

  constructor(logPath: string) {
    // Ensure directory exists
    const dir = path.dirname(logPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    this.stream = fs.createWriteStream(logPath, { flags: 'a' });
  }

  write(message: string): void {
    this.stream.write(message);
  }

  end(): void {
    this.stream.end();
  }
}


