# Report & Content Moderation Backend

A dedicated microservice backend for handling user-submitted AI content reports and moderation in the **AfterClick AI Photo Enhancer** app.

---

## 🚀 Features

- **Store Reports**: Submissions from `ReportContentModal` (`reason`, `details`, `imageUri`, `platform`, `timestamp`, `reporterIp`).
- **Resilient Storage**:
  - Connects to **MongoDB** via Mongoose.
  - If MongoDB is offline, automatically saves to a **Local File Backup (`data/reports_backup.json`)**, ensuring zero data loss and zero server crashes.
- **Moderation APIs**: Full CRUD to view, filter, review, resolve, and delete reports.
- **Analytics & Statistics**: Quick overview of reported content categories and resolution status.

---

## 🛠️ Quick Start

### 1. Install Dependencies
```bash
cd report-backend
npm install
```

### 2. Configure Environment (`.env`)
```env
PORT=5001
MONGO_URI=mongodb://127.0.0.1:27017/ai-photo-reports
NODE_ENV=development
```

### 3. Run the Server
```bash
# Production / Normal run
npm start

# Development (with auto-reload)
npm run dev
```

---

## 📡 API Endpoints

### 1. Submit a Report (Used by Mobile App)
- **POST** `/api/reports`
- **Body**:
```json
{
  "reason": "nsfw",
  "details": "This AI generation resulted in inappropriate content",
  "imageUri": "file:///path/or/url/to/image.jpg",
  "platform": "android"
}
```
- **Response**: `201 Created`
```json
{
  "success": true,
  "message": "Report submitted successfully. Our moderation team will review this content.",
  "reportId": "..."
}
```

### 2. List All Reports (Admin / Moderation)
- **GET** `/api/reports?status=pending&limit=20&page=1`
- **Filters**:
  - `status`: `pending`, `in_review`, `resolved`, `dismissed`
  - `reason`: `nsfw`, `hate`, `violence`, `offensive_ai`, `privacy`, `other`
  - `platform`: `ios`, `android`, `web`

### 3. Summary Statistics
- **GET** `/api/reports/stats/summary`

### 4. Update Report Status (Admin Review)
- **PATCH** `/api/reports/:id`
```json
{
  "status": "resolved",
  "reviewNotes": "Reviewed and prompt filtered."
}
```

### 5. Delete Report
- **DELETE** `/api/reports/:id`

