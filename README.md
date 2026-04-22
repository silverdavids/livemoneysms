# live-sms

Node.js + Express API for live SMS viewing backed by SQL Server.

## Run

```powershell
npm install
npm start
```

The server starts on `http://localhost:3000` by default.

## API Endpoints

- `POST /api/login`
- `POST /api/logout`
- `GET /api/me`
- `GET /api/messages`
- `GET /api/devices`
- `POST /api/user-devices`

## Authentication Notes

Authentication uses `express-session` and stores the logged-in user in the server session.

`POST /api/login` verifies passwords with `bcrypt` against `sms.Users.PasswordHash`.

If a user row still contains a placeholder like `TEMP_HASH`, login will fail until that value is replaced with a real bcrypt hash.

Generate a bcrypt hash locally with:

```powershell
node -e "require('bcrypt').hash('pwd123', 10).then(x => console.log(x))"
```

## Quick Test

Use the included [api.http](/abs/C:/Projects/Node/live-sms/api.http:1) file, or test manually in PowerShell:

```powershell
$session = New-Object Microsoft.PowerShell.Commands.WebRequestSession

Invoke-RestMethod `
  -Uri http://127.0.0.1:3000/api/login `
  -Method Post `
  -ContentType 'application/json' `
  -Body '{"username":"admin","password":"pwd123"}' `
  -WebSession $session

Invoke-RestMethod http://127.0.0.1:3000/api/me -WebSession $session
Invoke-RestMethod http://127.0.0.1:3000/api/messages -WebSession $session
Invoke-RestMethod http://127.0.0.1:3000/api/devices -WebSession $session

Invoke-RestMethod `
  -Uri http://127.0.0.1:3000/api/user-devices `
  -Method Post `
  -ContentType 'application/json' `
  -Body '{"userId":"558D4987-BC73-4AA6-894D-8CA80F944D7E","deviceId":"0a0d88af8c602c19","isActive":true}' `
  -WebSession $session

Invoke-RestMethod `
  -Uri http://127.0.0.1:3000/api/logout `
  -Method Post `
  -WebSession $session
```
