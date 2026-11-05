// tools/ai-patcher.js
import fs from 'fs';
import path from 'path';
import 'dotenv/config';
import { GoogleGenAI, Type } from '@google/genai';

const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) {
  console.error('❌ Thiếu GEMINI_API_KEY trong file .env');
  process.exit(1);
}

const ai = new GoogleGenAI({ apiKey });

async function patchFile(targetFilePath, userInstruction) {
  const fullPath = path.resolve(targetFilePath);
  if (!fs.existsSync(fullPath)) {
    console.error(`❌ Không tìm thấy file: ${fullPath}`);
    process.exit(1);
  }

  const originalContent = fs.readFileSync(fullPath, 'utf8');

  // 1. Tạo backup an toàn trước khi xử lý
  const backupPath = `${fullPath}.bak`;
  fs.writeFileSync(backupPath, originalContent, 'utf8');
  console.log(`📦 Đã tạo bản sao lưu tại: ${path.basename(backupPath)}`);

  // 2. Định nghĩa System Instruction yêu cầu chỉ xuất Search/Replace Block
  const systemInstruction = `
Bạn là công cụ lập trình tự động hóa mã nguồn (Code Patching Engine).
Nhiệm vụ: Dựa vào mã nguồn của người dùng và yêu cầu chỉnh sửa, hãy xác định các vị trí cần sửa và trả về mảng các thao tác Search & Replace.
Quy tắc bất biến:
- Đoạn "search" PHẢI trùng khớp 100% từng ký tự, dấu cách, dòng xuống với văn bản gốc trong file.
- Đoạn "search" phải đủ dài để đảm bảo tính duy nhất (unique) trong file.
- Đoạn "replace" là mã nguồn mới thay thế.
- Không tự ý rút ngắn code bằng dấu ba chấm (...).
`;

  console.log(`🤖 Đang phân tích và tạo bản vá qua Gemini 2.5 Flash...`);

  try {
    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: [
        {
          role: 'user',
          parts: [
            { text: `NỘI DUNG FILE HIỆN TẠI:\n\n${originalContent}` },
            { text: `YÊU CẦU CHỈNH SỬA:\n${userInstruction}` }
          ]
        }
      ],
      config: {
        systemInstruction,
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.ARRAY,
          description: 'Danh sách các thao tác thay thế mã nguồn',
          items: {
            type: Type.OBJECT,
            properties: {
              description: { type: Type.STRING, description: 'Mô tả vị trí sửa' },
              search: { type: Type.STRING, description: 'Đoạn mã gốc chính xác cần tìm' },
              replace: { type: Type.STRING, description: 'Đoạn mã mới thay thế' }
            },
            required: ['search', 'replace']
          }
        }
      }
    });

    const patches = JSON.parse(response.text.trim());
    if (!Array.isArray(patches) || patches.length === 0) {
      console.log('⚠️ AI không phát hiện thay đổi nào cần thực hiện.');
      return;
    }

    let updatedContent = originalContent;
    let successCount = 0;

    for (const patch of patches) {
      console.log(`\n🔧 Đang xử lý: ${patch.description || 'Thay thế code'}`);
      
      // Chuẩn hóa ký tự xuống dòng tránh xung đột CRLF (Windows) và LF (Linux/Mac)
      const normalizedOriginal = updatedContent.replace(/\r\n/g, '\n');
      const normalizedSearch = patch.search.replace(/\r\n/g, '\n');
      const normalizedReplace = patch.replace.replace(/\r\n/g, '\n');

      if (!normalizedOriginal.includes(normalizedSearch)) {
        console.error(`❌ Thất bại: Không tìm thấy đoạn code search trong file gốc!`);
        continue;
      }

      updatedContent = normalizedOriginal.replace(normalizedSearch, normalizedReplace);
      successCount++;
      console.log(`✅ Đã thay thế thành công.`);
    }

    if (successCount === 0) {
      console.error('\n❌ Không có bản vá nào khớp. Khôi phục file gốc từ backup.');
      fs.writeFileSync(fullPath, originalContent, 'utf8');
      return;
    }

    fs.writeFileSync(fullPath, updatedContent, 'utf8');
    console.log(`\n🎉 Hoàn tất! Đã áp dụng ${successCount}/${patches.length} chỉnh sửa trực tiếp vào ${path.basename(fullPath)}`);

  } catch (err) {
    console.error('❌ Lỗi xử lý:', err);
    fs.writeFileSync(fullPath, originalContent, 'utf8');
    console.log('Đã khôi phục trạng thái ban đầu.');
  }
}

// Lấy tham số dòng lệnh CLI
const [, , targetFile, ...promptArgs] = process.argv;
const instruction = promptArgs.join(' ');

if (!targetFile || !instruction) {
  console.log(`Cú pháp sử dụng: node tools/ai-patcher.js <đường_dẫn_file> "<yêu_cầu_sửa>"`);
  process.exit(1);
}

patchFile(targetFile, instruction);