CREATE TABLE IF NOT EXISTS error_logs (
										  id           INTEGER PRIMARY KEY AUTOINCREMENT,
	                                      source       TEXT    NOT NULL,
	                                      action       TEXT    NOT NULL,
	                                      jobId        TEXT,
	                                      unitRentalId TEXT,
	                                      error        TEXT    NOT NULL,
	                                      createdAt    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_logs_createdAt    ON error_logs(createdAt);
CREATE INDEX IF NOT EXISTS idx_logs_unitRentalId ON error_logs(unitRentalId);

CREATE TABLE IF NOT EXISTS processed_jobs (
											  jobId       TEXT    PRIMARY KEY,
	                                          processedAt INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_jobs_processedAt ON processed_jobs(processedAt);
