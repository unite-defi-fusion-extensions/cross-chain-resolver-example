import '@ton/test-utils';

// Global test setup
beforeAll(() => {
  // Set test environment variables
  process.env.NODE_ENV = 'test';
  
  // Increase timeout for blockchain operations
  jest.setTimeout(30000);
});

// Global test cleanup
afterAll(() => {
  // Clean up any resources if needed
});

// Mock console.log in tests to reduce noise (optional)
// global.console = {
//   ...console,
//   log: jest.fn(),
//   debug: jest.fn(),
//   info: jest.fn(),
//   warn: jest.fn(),
//   error: console.error, // Keep error logs for debugging
// };
