import { createClient } from '@supabase/supabase-js';
import { NextResponse } from 'next/server';
import OpenAI from 'openai';

// Initialize OpenAI with the provided API key and base URL (now using qwen2.5-vl-32b-instruct)
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  baseURL: process.env.OPENAI_BASE_URL,
});

// Initialize Supabase with the service role key for admin access
const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

export async function POST(request: Request) {
  try {
    // Parse the request body
    const { text, userId, imageUrl } = await request.json();

    // Validate inputs - either text or imageUrl must be provided
    if ((!text || text.trim() === '') && !imageUrl) {
      return NextResponse.json(
        { error: '请提供文本内容或图片' },
        { status: 400 }
      );
    }

    if (!userId) {
      return NextResponse.json(
        { error: '缺少用户ID' },
        { status: 400 }
      );
    }

    let todoItems: string[] = [];

    // If there's an image, we need to process it with the vision model
    if (imageUrl) {
      // System prompt in Chinese
      const systemMessage = {
        role: 'system' as const,
        content: `你是一个专门提取待办事项的助手。请分析用户的图片和文本，识别其中所有的待办事项。
                  如果是图片，请识别图片中的文字内容并提取待办事项。
                  仅提取文字中存在的待办事项，不要添加任何额外内容。
                  提取的内容以原文原语言展示，不要翻译。
                  返回格式为JSON对象，包含一个"tasks"数组，数组中包含所有待办事项字符串。
                  示例输出: {"tasks": ["买牛奶", "打电话给医生", "完成报告"]}
                  仅输出JSON对象，不要有任何其他内容。`
      };
      
      // Prepare user content with text and/or image
      const userContent = [];
      
      if (text && text.trim() !== '') {
        userContent.push({
          type: 'text' as const,
          text: text
        });
      }
      
      // Add image
      userContent.push({
        type: 'image_url' as const,
        image_url: {
          url: imageUrl
        }
      });
      
      // User message with text and/or image
      const userMessage = {
        role: 'user' as const,
        content: userContent
      };
      
      // Call the qwen2.5-vl-32b-instruct model for image understanding
      const completion = await openai.chat.completions.create({
        model: 'qwen2.5-vl-32b-instruct',
        // model: 'deepseek-chat',
        messages: [systemMessage, userMessage],
        response_format: { type: 'json_object' },
      });

      const responseContent = completion.choices[0].message.content;
      
      if (!responseContent) {
        return NextResponse.json(
          { error: '无法从AI响应中解析待办事项' },
          { status: 500 }
        );
      }

      try {
        // Extract the array of todos from the JSON response
        const parsedResponse = JSON.parse(responseContent);
        todoItems = Array.isArray(parsedResponse.tasks) 
          ? parsedResponse.tasks 
          : [responseContent]; // Fallback if AI didn't return expected format
      } catch (error) {
        console.error('Error parsing AI response:', error);
        // Fallback: treat the entire response as a single todo
        todoItems = [responseContent];
      }
    } 
    // If there's only text but no image, use text-only processing
    else if (text) {
      const completion = await openai.chat.completions.create({
        model: 'qwen2.5-vl-32b-instruct',
        // model: 'deepseek-chat',
        messages: [
          {
            role: 'system' as const,
            content: `你是一个专门提取待办事项的助手。请分析用户的文本，识别其中所有的待办事项。
                      仅提取文字中存在的待办事项，不要添加任何额外内容。
                      提取的内容以原文原语言展示，不要翻译。
                      返回格式为JSON对象，包含一个"tasks"数组，数组中包含所有待办事项字符串。
                      示例输出: {"tasks": ["买牛奶", "打电话给医生", "完成报告"]}
                      仅输出JSON对象，不要有任何其他内容。`,
          },
          {
            role: 'user' as const,
            content: text,
          },
        ],
        response_format: { type: 'json_object' },
      });

      const responseContent = completion.choices[0].message.content;
      
      if (!responseContent) {
        return NextResponse.json(
          { error: '无法从AI响应中解析待办事项' },
          { status: 500 }
        );
      }

      try {
        // Extract the array of todos from the JSON response
        const parsedResponse = JSON.parse(responseContent);
        todoItems = Array.isArray(parsedResponse.tasks) 
          ? parsedResponse.tasks 
          : [responseContent]; // Fallback if AI didn't return expected format
      } catch (error) {
        console.error('Error parsing AI response:', error);
        // Fallback: treat the entire response as a single todo
        todoItems = [responseContent];
      }
    }

    // Filter out any empty todos
    todoItems = todoItems.filter(item => item && item.trim().length > 0);

    if (todoItems.length === 0) {
      return NextResponse.json(
        { error: '在提供的内容中未找到有效的待办事项' },
        { status: 400 }
      );
    }

    // Create todo items in Supabase
    // If multiple todos were extracted, attach the image to the first todo only
    const todoPromises = todoItems.map((todoText, index) => {
      return supabaseAdmin
        .from('todos')
        .insert([
          {
            text: todoText.trim(),
            completed: false,
            user_id: userId,
            image_url: index === 0 ? imageUrl : null, // Only attach image to first todo
          },
        ]);
    });

    // Wait for all insert operations to complete
    const results = await Promise.all(todoPromises);
    
    // Check for any errors in the results
    const errors = results.filter(result => result.error);
    if (errors.length > 0) {
      console.error('Error inserting todos:', errors);
      return NextResponse.json(
        { error: '插入部分或全部待办事项失败', details: errors },
        { status: 500 }
      );
    }

    // Return success response with created todos
    return NextResponse.json({ 
      success: true,
      count: todoItems.length,
      message: `已创建 ${todoItems.length} 个待办事项`,
    });
  } catch (error) {
    console.error('Error processing request:', error);
    return NextResponse.json(
      { error: '处理请求失败', details: String(error) },
      { status: 500 }
    );
  }
} 