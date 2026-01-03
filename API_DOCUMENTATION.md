# RentTrack API Documentation

Base URL: `http://localhost:3000/api`

## Authentication Endpoints

All authentication endpoints are under `/api/auth`.

### 1. Sign Up Landlord

Create a new landlord account.

**Endpoint:** `POST /api/auth/signup-landlord`

**Request Body:**
```json
{
  "email": "landlord@example.com",
  "password": "SecurePass123",
  "name": "John Doe"
}
```

**Response:** `201 Created`
```json
{
  "status": "success",
  "data": {
    "user": {
      "id": "uuid",
      "email": "landlord@example.com",
      "name": "John Doe",
      "landlordId": "uuid"
    }
  },
  "message": "Landlord account created successfully"
}
```

**Errors:**
- `400` - Validation error (missing fields)
- `409` - User already exists

---

### 2. Login

Authenticate user and receive JWT tokens.

**Endpoint:** `POST /api/auth/login`

**Request Body:**
```json
{
  "email": "landlord@example.com",
  "password": "SecurePass123"
}
```

**Response:** `200 OK`
```json
{
  "status": "success",
  "data": {
    "tokens": {
      "idToken": "eyJhbGc...",
      "accessToken": "eyJhbGc...",
      "refreshToken": "eyJjdHk...",
      "cognitoId": "uuid"
    },
    "user": {
      "id": "uuid",
      "email": "landlord@example.com",
      "name": "John Doe"
    },
    "memberships": {
      "landlord": {
        "id": "uuid"
      },
      "tenants": []
    }
  }
}
```

**Tokens:**
- `idToken`: Contains user identity (optional - for client-side display only)
- `accessToken`: Required for ALL API requests including authentication (1 hour expiry)
- `refreshToken`: Use to get new tokens when expired
- `cognitoId`: Required for refresh token requests

**Errors:**
- `400` - Validation error
- `401` - Invalid credentials
- `404` - User not found

---

### 3. Refresh Tokens

Get new access and ID tokens using refresh token.

**Endpoint:** `POST /api/auth/refresh`

**Request Body:**
```json
{
  "refreshToken": "eyJjdHk...",
  "cognitoId": "uuid"
}
```

**Response:** `200 OK`
```json
{
  "status": "success",
  "data": {
    "tokens": {
      "idToken": "eyJhbGc...",
      "accessToken": "eyJhbGc..."
    }
  }
}
```

**Note:** Refresh tokens do not expire unless revoked via logout.

**Errors:**
- `400` - Missing refreshToken or cognitoId
- `401` - Invalid or expired refresh token

---

### 4. Forgot Password

Request password reset code via email.

**Endpoint:** `POST /api/auth/forgot-password`

**Request Body:**
```json
{
  "email": "landlord@example.com"
}
```

**Response:** `200 OK`
```json
{
  "status": "success",
  "data": {
    "message": "Password reset code sent to email"
  },
  "message": "If the email exists, a reset code has been sent"
}
```

**Note:** Always returns success for security (doesn't reveal if email exists).

**Errors:**
- `400` - Email is required

---

### 5. Reset Password

Confirm password reset with verification code.

**Endpoint:** `POST /api/auth/reset-password`

**Request Body:**
```json
{
  "email": "landlord@example.com",
  "code": "123456",
  "newPassword": "NewSecurePass456"
}
```

**Response:** `200 OK`
```json
{
  "status": "success",
  "data": {
    "message": "Password reset successful"
  },
  "message": "You can now login with your new password"
}
```

**Errors:**
- `400` - Missing required fields
- `400` - Invalid or expired code
- `400` - Password doesn't meet requirements

---

### 6. Change Password

Change password for authenticated user (requires old password).

**Endpoint:** `POST /api/auth/change-password`

**Headers:**
```
Authorization: Bearer <accessToken>
```

**Request Body:**
```json
{
  "oldPassword": "CurrentPass123",
  "newPassword": "NewSecurePass456"
}
```

**Response:** `200 OK`
```json
{
  "status": "success",
  "data": {
    "message": "Password changed successfully"
  },
  "message": "Your password has been updated"
}
```

**Important:** Use `accessToken` (not `idToken`) in Authorization header.

**Errors:**
- `400` - Missing required fields
- `401` - Invalid access token
- `400` - Incorrect old password
- `400` - New password doesn't meet requirements

---

### 7. Logout

Revoke all tokens globally for the authenticated user.

**Endpoint:** `POST /api/auth/logout`

**Headers:**
```
Authorization: Bearer <accessToken>
```

**Response:** `200 OK`
```json
{
  "status": "success",
  "data": {
    "message": "Logged out successfully"
  },
  "message": "All tokens have been revoked"
}
```

**Important:** Use `accessToken` (not `idToken`) in Authorization header.

**Note:** After logout, all existing tokens (id, access, refresh) become invalid.

**Errors:**
- `401` - Invalid or missing access token

---

### 8. Get Current User

Get authenticated user's profile and memberships.

**Endpoint:** `GET /api/auth/me`

**Headers:**
```
Authorization: Bearer <accessToken>
```

**Response:** `200 OK`
```json
{
  "status": "success",
  "data": {
    "user": {
      "id": "uuid",
      "email": "landlord@example.com",
      "name": "John Doe",
      "cognitoId": "uuid"
    },
    "memberships": {
      "landlord": {
        "id": "uuid"
      },
      "tenants": [
        {
          "id": "uuid",
          "unitId": "uuid",
          "unitName": "Apt 101",
          "propertyName": "Sunset Apartments",
          "status": "ACTIVE"
        }
      ]
    }
  }
}
```

**Important:** Use `accessToken` in Authorization header.

**Errors:**
- `401` - No token provided or invalid token
- `404` - User not found in database

---

## Authentication Flow

### Initial Login Flow
1. User signs up: `POST /api/auth/signup-landlord`
2. User logs in: `POST /api/auth/login`
3. Frontend stores all tokens + cognitoId
4. Use `idToken` for API requests
5. When token expires (1 hour), use refresh token

### Token Refresh Flow
1. Frontend detects 401 error or token expiry
2. Call `POST /api/auth/refresh` with `refreshToken` + `cognitoId`
3. Receive new `idToken` and `accessToken`
4. Retry failed request with new `idToken`

### Password Reset Flow
1. User requests reset: `POST /api/auth/forgot-password`
2. User receives code via email
3. User submits code: `POST /api/auth/reset-password`
4. User logs in with new password

### Change Password Flow (Authenticated)
1. User is logged in with valid tokens
2. Call `POST /api/auth/change-password` with `accessToken`
3. Provide old password and new password
4. Continue using existing tokens

### Logout Flow
1. Call `POST /api/auth/logout` with `accessToken`
2. All tokens are revoked globally
3. Frontend clears stored tokens
4. Redirect to login page

---

## Token Usage

| Endpoint | Token Required | Token Type |
|----------|---------------|------------|
| Sign Up | No | - |
| Login | No | - |
| Refresh | Yes (body) | `refreshToken` + `cognitoId` |
| Forgot Password | No | - |
| Reset Password | No | - |
| Change Password | Yes (header) | `accessToken` |
| Logout | Yes (header) | `accessToken` |
| Get Current User | Yes (header) | `accessToken` |
| Properties (other routes) | Yes (header) | `accessToken` |

---

## Error Response Format

All error responses follow this format:

```json
{
  "status": "error" | "fail",
  "message": "Human-readable error message",
  "error": {
    "statusCode": 400,
    "status": "fail",
    "isOperational": true
  },
  "stack": "Error stack trace (development only)"
}
```

**Status Types:**
- `fail`: Client error (4xx) - validation, not found, etc.
- `error`: Server error (5xx) - unexpected errors

**Common HTTP Status Codes:**
- `200` - Success
- `201` - Created (signup)
- `400` - Bad Request (validation error)
- `401` - Unauthorized (invalid/missing token)
- `404` - Not Found (user/resource not found)
- `409` - Conflict (user already exists)
- `500` - Internal Server Error

---

## Password Requirements

Passwords must meet AWS Cognito requirements:
- Minimum 8 characters
- At least one uppercase letter
- At least one lowercase letter
- At least one number
- Special characters recommended

---

## Rate Limiting

Currently no rate limiting implemented. Consider adding rate limiting for:
- Login attempts (prevent brute force)
- Password reset requests (prevent abuse)
- Token refresh (prevent token farming)

---

## Security Notes

1. **Always use HTTPS in production** - Tokens are sensitive
2. **Store tokens securely** - Use secure storage (not localStorage for sensitive apps)
3. **Implement token refresh** - Don't wait for 401 errors
4. **Clear tokens on logout** - Remove from all storage locations
5. **Use accessToken for password operations** - Not idToken
6. **Validate on backend** - Never trust client-side validation alone
7. **Monitor failed login attempts** - Implement account lockout if needed

---

## Frontend Integration Example

### Store Tokens After Login
```javascript
const response = await fetch('/api/auth/login', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email, password })
});

const data = await response.json();

// Store tokens (accessToken is required, idToken is optional)
localStorage.setItem('accessToken', data.data.tokens.accessToken);
localStorage.setItem('refreshToken', data.data.tokens.refreshToken);
localStorage.setItem('cognitoId', data.data.tokens.cognitoId);
localStorage.setItem('user', JSON.stringify(data.data.user));
```

### Make Authenticated Request
```javascript
const accessToken = localStorage.getItem('accessToken');

const response = await fetch('/api/properties', {
  headers: {
    'Authorization': `Bearer ${accessToken}`
  }
});

if (response.status === 401) {
  // Token expired, refresh it
  await refreshTokens();
}
```

### Refresh Tokens
```javascript
async function refreshTokens() {
  const refreshToken = localStorage.getItem('refreshToken');
  const cognitoId = localStorage.getItem('cognitoId');

  const response = await fetch('/api/auth/refresh', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refreshToken, cognitoId })
  });

  const data = await response.json();
  
  // Update tokens
  localStorage.setItem('idToken', data.data.tokens.idToken);
  localStorage.setItem('accessToken', data.data.tokens.accessToken);
}
```

### Logout
```javascript
async function logout() {
  const accessToken = localStorage.getItem('accessToken');

  await fetch('/api/auth/logout', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`
    }
  });

  // Clear all tokens
  localStorage.clear();
  // Redirect to login
  window.location.href = '/login';
}
```

---

## Testing

### Using cURL

**Sign Up:**
```bash
curl -X POST http://localhost:3000/api/auth/signup-landlord \
  -H "Content-Type: application/json" \
  -d '{"email":"test@example.com","password":"TestPass123","name":"Test User"}'
```

**Login:**
```bash
curl -X POST http://localhost:3000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"test@example.com","password":"TestPass123"}'
```

**Get Current User:**
```bash
curl -X GET http://localhost:3000/api/auth/me \
  -H "Authorization: Bearer YOUR_ACCESS_TOKEN"
```

**Change Password:**
```bash
curl -X POST http://localhost:3000/api/auth/change-password \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_ACCESS_TOKEN" \
  -d '{"oldPassword":"TestPass123","newPassword":"NewPass456"}'
```

---

## Development Notes

- Tokens expire after 1 hour (Cognito default)
- Refresh tokens don't expire unless revoked
- Cognito User Pool: `us-east-2_FEB82bZzf`
- Database uses UUID for user IDs
- All timestamps in UTC
- Pagination available on list endpoints (see specific endpoint docs)
